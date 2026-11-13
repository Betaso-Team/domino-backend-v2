import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpClient } from "@/shared/http";
import type { Logger } from "@/shared/logger";
import { decimal } from "@/shared/money";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BET_CHARGE_WINDOW_MS } from "../../core/config";
import type { NetworkMatchEvent } from "../events";
import {
  BET_CHARGE_TIMEOUT_MS,
  ChargeRejectedError,
  OrchestratorBetCharger,
  type OrchestratorCharges,
  OrchestratorUnavailableError,
} from "../orchestrator-charges";
import { HttpOrchestratorCharges } from "../transports/http-orchestrator";

function silentLogger(): Logger {
  const self: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => self,
  };
  return self;
}

const agreed = (level: number, additionalEntryFee = decimal("10")): NetworkMatchEvent => ({
  type: "MULTIPLIER_AGREED",
  level,
  extra: 1,
  additionalEntryFee,
  playerIds: ["seat-1", "seat-2"],
});

const REVOKED: NetworkMatchEvent[] = [{ type: "MULTIPLIER_REVOKED", level: 2 }];
const CONFIRMED: NetworkMatchEvent[] = [{ type: "MULTIPLIER_CONFIRMED", level: 2 }];

function charger(
  chargeBet: OrchestratorCharges["chargeBet"],
  timeoutMs = 1_000,
  confirmImpl: () => readonly NetworkMatchEvent[] = () => CONFIRMED,
) {
  const emitted: NetworkMatchEvent[][] = [];
  const revoke = vi.fn(() => REVOKED);
  const confirm = vi.fn(confirmImpl);
  const log = silentLogger();
  const { sink, settled } = new OrchestratorBetCharger({
    orchestrator: { chargeEntry: vi.fn(), chargeBet: vi.fn(chargeBet) },
    timeoutMs,
    log,
  }).sinkFor("m-1", (events) => emitted.push([...events]), { confirm, revoke });
  return { sink, settled, emitted, revoke, confirm, log };
}

describe("OrchestratorBetCharger", () => {
  // EL AUMENTO SUBE A LA MESA RECIÉN CON EL COBRO HECHO: el motor lo dejó aceptado y esperando, y el
  // que lo confirma es esto, después de que el orquestador cobró a los dos.
  it("cobrado: se confirma el aumento y no se anula nada", async () => {
    const chargeBet = vi.fn(async () => undefined);
    const { sink, emitted, revoke, confirm } = charger(chargeBet);

    sink([agreed(2)]);
    await vi.waitFor(() => expect(emitted).toEqual([CONFIRMED]));

    expect(chargeBet).toHaveBeenCalledWith("m-1", 0, 2);
    expect(confirm).toHaveBeenCalledOnce();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("confirmar no anuncia nada si la mesa ya no tenía el aumento esperando", async () => {
    const { sink, emitted, log } = charger(
      async () => undefined,
      1_000,
      () => [],
    );

    sink([agreed(2)]);
    await vi.waitFor(() => expect(log.error).toHaveBeenCalled());

    expect(emitted).toEqual([]);
  });

  it.each([
    ["rechazado", async () => Promise.reject(new ChargeRejectedError("INSUFFICIENT_FUNDS"))],
    [
      "sin orquestador",
      async () => Promise.reject(new OrchestratorUnavailableError("ECONNREFUSED")),
    ],
    ["sin respuesta a tiempo", () => new Promise<void>(() => {})],
  ])("%s: el aumento se anula", async (_, chargeBet) => {
    const { sink, emitted } = charger(chargeBet, 20);

    sink([agreed(2)]);

    await vi.waitFor(() => expect(emitted).toEqual([REVOKED]));
  });

  it("cada aumento acordado de la mesa lleva su número, también después de uno anulado", async () => {
    const chargeBet = vi.fn(async () => Promise.reject(new ChargeRejectedError("X")));
    const { sink, emitted } = charger(chargeBet);

    sink([agreed(2)]);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    sink([agreed(3)]);
    await vi.waitFor(() => expect(emitted).toHaveLength(2));

    expect(chargeBet.mock.calls.map((call) => call.slice(1))).toEqual([
      [0, 2],
      [1, 3],
    ]);
  });

  it("settled espera al cobro en vuelo y resuelve con el trato ya anulado si no se pudo", async () => {
    let answer = () => {};
    const { sink, settled, revoke } = charger(
      () =>
        new Promise<void>((_, reject) => {
          answer = () => reject(new ChargeRejectedError("INSUFFICIENT_FUNDS"));
        }),
    );

    sink([agreed(2)]);
    let done = false;
    const waiting = settled().then(() => {
      done = true;
    });
    await new Promise((resume) => setTimeout(resume, 0));
    expect(done).toBe(false);

    answer();
    await waiting;
    expect(revoke).toHaveBeenCalledOnce();
  });

  // UN AUMENTO QUE NO CUESTA NADA no se le pide al orquestador, pero igual se confirma: si no, la
  // mesa quedaría congelada esperando un cobro que nadie hace, hasta que el reloj lo anulara.
  it("un aumento que no cuesta nada no se cobra y se confirma igual", async () => {
    const chargeBet = vi.fn(async () => undefined);
    const { sink, emitted } = charger(chargeBet);

    sink([agreed(2, decimal("0"))]);
    await vi.waitFor(() => expect(emitted).toEqual([CONFIRMED]));

    expect(chargeBet).not.toHaveBeenCalled();
  });

  it("después de uno gratis, el siguiente cobrado sigue numerándose desde 0", async () => {
    const chargeBet = vi.fn(async () => undefined);
    const { sink, emitted } = charger(chargeBet);

    sink([agreed(2, decimal("0"))]);
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    sink([agreed(3)]);
    await vi.waitFor(() => expect(emitted).toHaveLength(2));

    expect(chargeBet.mock.calls.map((call) => call.slice(1))).toEqual([[0, 3]]);
  });

  // EL PLAZO DE LA RED ES MÁS CORTO QUE LA RED DE SEGURIDAD DEL MOTOR: así el que decide si el
  // aumento vale es siempre el cobro, y el reloj de la mesa sólo anula lo que la red nunca contestó.
  it("el cobro se rinde antes de que la mesa deje de esperarlo", () => {
    expect(BET_CHARGE_TIMEOUT_MS).toBeLessThan(BET_CHARGE_WINDOW_MS);
  });
});

describe("HttpOrchestratorCharges", () => {
  let server: Server;
  let base: string;
  const seen: Array<{ url?: string; key?: string; body: string; deadline?: string }> = [];
  let status = 200;
  let reply = "{}";
  let hang = false;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        seen.push({
          url: request.url,
          key: request.headers["x-internal-api-key"] as string,
          body,
          deadline: request.headers["x-charge-deadline"] as string,
        });
        const head = response.writeHead(status, { "content-type": "application/json" });
        // CUERPO COLGADO: las cabeceras salen y el cuerpo no termina nunca.
        if (hang) head.write('{"ok":');
        else head.end(reply);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  const NOW = Date.UTC(2026, 10, 11, 12);
  const client = (timeoutMs?: number) =>
    new HttpOrchestratorCharges(
      new HttpClient({ baseUrl: base }),
      "callback-key-123456",
      { entryMs: timeoutMs ?? 10_000, betMs: timeoutMs ?? 15_000 },
      () => NOW,
    );

  it("pide la entrada y el aumento con la llave del orquestador", async () => {
    status = 200;
    await client().chargeEntry("m/1");
    await client().chargeBet("m-1", 1, 3);

    // `x-charge-deadline`: el instante (epoch ms) en que el dominó deja de esperar cada cobro.
    expect(seen.slice(-2)).toEqual([
      {
        url: "/v1/matches/m%2F1/charges",
        key: "callback-key-123456",
        body: "{}",
        deadline: String(NOW + 10_000),
      },
      {
        url: "/v1/matches/m-1/bets",
        key: "callback-key-123456",
        body: '{"step":1,"level":3}',
        deadline: String(NOW + 15_000),
      },
    ]);
  });

  it("409 es un rechazo, con el código que dio el orquestador", async () => {
    status = 409;
    reply = '{"code":"INSUFFICIENT_FUNDS"}';
    await expect(client().chargeEntry("m-1")).rejects.toMatchObject({
      name: "ChargeRejectedError",
      code: "INSUFFICIENT_FUNDS",
    });
  });

  it("cualquier otro status es no poder preguntar, no un rechazo", async () => {
    status = 401;
    reply = '{"error":"UNAUTHORIZED"}';
    await expect(client().chargeEntry("m-1")).rejects.toBeInstanceOf(OrchestratorUnavailableError);
  });

  // EL CUERPO COLGADO YA NO TRABA LA MESA en `charging`: el plazo del cliente lo corta, y para la
  // mesa es "no se pudo preguntar", como cualquier otro plazo.
  it("un 200 con el cuerpo colgado es no poder preguntar, dentro del plazo", async () => {
    status = 200;
    hang = true;
    try {
      const started = performance.now();
      await expect(client(200).chargeEntry("m-1")).rejects.toThrow(
        /el orquestador no contestó el cobro: DeadlineExceededError/,
      );
      expect(performance.now() - started).toBeLessThan(700);
    } finally {
      hang = false;
    }
  });
});
