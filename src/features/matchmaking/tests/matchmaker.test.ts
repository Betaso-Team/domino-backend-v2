import type { DominoRoomOptions } from "@/features/match";
import { MemoryKeyValueStore } from "@/shared/kv";
import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MATCHMAKING_CONFIG } from "../config";
import { CooldownBook, DEFAULT_COOLDOWN } from "../core/cooldown";
import { MatchmakingError } from "../errors";
import type { MatchGateway, Seat } from "../gateway";
import { type Maintenance, type MaintenanceSignal, OPEN } from "../maintenance";
import { Matchmaker } from "../matchmaker";
import type { Ticket } from "../pool";
import type { PoolDirectory, PoolRequest, PoolSpec, Requester } from "../pool-spec";
import { MemoryMatchPool } from "../transports/memory-pool";

// The matcher with the real queue — it is in memory and not worth faking — and the TWO ports that
// talk to the world faked: the scope and the opening of a match.

const CASUAL: PoolRequest = { kind: "CASUAL", gameModeId: "mesa" };
const requester = (playerId: string): Requester => ({ playerId, token: `t-${playerId}` });

// `request` returns the SEAT's promise, which does not resolve until there is a match — so it cannot
// be awaited to know it has queued. Its internal awaits are all immediate, since the fake scope waits
// on no network, so yielding the turn once is enough. Without this, a test acting "right after"
// asking acts against a queue that is still empty.
const enqueued = () => new Promise((resolve) => setImmediate(resolve));

// Records the matches opened and returns one seat per player.
class FakeGateway implements MatchGateway {
  readonly opened: DominoRoomOptions[] = [];
  private failing = false;

  setFailing(failing: boolean): void {
    this.failing = failing;
  }

  async open(options: DominoRoomOptions): Promise<readonly Seat[]> {
    if (this.failing) throw new Error("no se pudo crear la sala");
    this.opened.push(options);
    return options.seats.map((playerId) => ({
      playerId,
      reservation: { roomId: `sala-${this.opened.length}`, playerId },
    }));
  }

  // Returning to a match in progress. It fails when there is no seat to give, which is what happens
  // in production when the player is still connected from somewhere else and the room is full.
  rejoinable = true;

  async rejoin(roomId: string, playerId: string): Promise<Seat> {
    if (!this.rejoinable) throw new Error("sala llena");
    return { playerId, reservation: { roomId, playerId } };
  }
}

// The maintenance signal, movable by hand. A fake and not the configured book because what is being
// exercised is the CHANGE: setting it is what fires the listeners, which is half the mechanism.
class FakeMaintenanceSignal implements MaintenanceSignal {
  private value: Maintenance = OPEN;
  private readonly listeners = new Set<(m: Maintenance) => void>();

  current(): Maintenance {
    return this.value;
  }

  onChange(listener: (m: Maintenance) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  set(value: Maintenance): void {
    this.value = value;
    for (const listener of this.listeners) listener(value);
  }
}

function spec(over: Partial<PoolSpec> = {}): PoolSpec {
  return {
    poolId: "mesa",
    seats: 2,
    pointsToWin: 12,
    admit: async () => {},
    avoid: async () => [],
    toRoomOptions: (group: readonly Ticket[], seed: string) => ({
      mode: "CASUAL",
      gameModeId: "mesa",
      seats: group.map((t) => t.playerId),
      seed,
      // `pointsToWin` y no el `targetScore` de truco: la mesa del dominó se gana por puntos y ese
      // es el nombre que `CasualRoomOptions` declara. `isFreeRoom` es el otro campo que el dominó
      // agrega, y en `0`/`0` la mesa es gratis de verdad.
      pointsToWin: 100,
      entryFee: 0,
      prize: 0,
      rankingWeight: 1,
      isFreeRoom: true,
    }),
    ...over,
  };
}

function build(specOver: Partial<PoolSpec> = {}, now = () => 1000) {
  const gateway = new FakeGateway();
  const pool = new MemoryMatchPool();
  // No shuffling: the tests about the cooldown need to know who got which.
  const cooldown = new CooldownBook(
    new MemoryKeyValueStore(now),
    DEFAULT_COOLDOWN,
    now,
    <T>(items: readonly T[]) => [...items],
  );
  const current = spec(specOver);
  const directory: PoolDirectory = { specOf: async () => current };
  // The process's live matches: by default nobody is playing.
  const live = new Map<string, string>();
  // The maintenance SIGNAL, open by default and movable: the state of the world a test changes
  // halfway. The whole thing is faked — not only the book — because what the matcher uses of it is
  // BOTH: reading how things stand now and hearing that they changed.
  const maintenance = new FakeMaintenanceSignal();
  const matchmaker = new Matchmaker({
    log: new MemoryLogger(),
    directory,
    pool,
    gateway,
    config: DEFAULT_MATCHMAKING_CONFIG,
    cooldown,
    live: { matchOf: async (playerId) => live.get(playerId) },
    maintenance,
    now,
    seedOf: () => "seed-fijo",
  });
  return { matchmaker, gateway, pool, cooldown, live, maintenance };
}

describe("Matchmaker: una petición, una respuesta", () => {
  it("el primero espera y el segundo los junta a los dos", async () => {
    const { matchmaker, gateway } = build();

    const first = matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);
    await enqueued();
    // Nobody else: they keep waiting, and no match was opened.
    await matchmaker.tick();
    expect(gateway.opened).toEqual([]);

    const second = matchmaker.request(CASUAL, requester("u2"), new AbortController().signal);
    const [s1, s2] = await Promise.all([first, second]);

    expect(gateway.opened).toHaveLength(1);
    expect(gateway.opened[0]?.seats).toEqual(["u1", "u2"]);
    expect(s1.playerId).toBe("u1");
    expect(s2.playerId).toBe("u2");
  });

  it("cada uno recibe SU reserva, no la del otro", async () => {
    const { matchmaker } = build();

    const first = matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);
    const second = matchmaker.request(CASUAL, requester("u2"), new AbortController().signal);
    const [s1, s2] = await Promise.all([first, second]);

    expect(s1.reservation).toMatchObject({ playerId: "u1" });
    expect(s2.reservation).toMatchObject({ playerId: "u2" });
  });

  it("una mesa de cuatro espera a los cuatro", async () => {
    const { matchmaker, gateway } = build({ seats: 4 });
    const signal = new AbortController().signal;

    const pending = ["u1", "u2", "u3"].map((id) =>
      matchmaker.request(CASUAL, requester(id), signal),
    );
    await enqueued();
    await matchmaker.tick();
    expect(gateway.opened).toEqual([]);

    pending.push(matchmaker.request(CASUAL, requester("u4"), signal));
    await Promise.all(pending);

    expect(gateway.opened[0]?.seats).toEqual(["u1", "u2", "u3", "u4"]);
  });

  it("con cuatro esperando en una mesa de dos, salen DOS partidas", async () => {
    const { matchmaker, gateway } = build();
    const signal = new AbortController().signal;

    await Promise.all(
      ["u1", "u2", "u3", "u4"].map((id) => matchmaker.request(CASUAL, requester(id), signal)),
    );

    expect(gateway.opened.map((o) => o.seats)).toEqual([
      ["u1", "u2"],
      ["u3", "u4"],
    ]);
  });
});

describe("Matchmaker: el cooldown de reentrada", () => {
  // What the cooldown buys is that two people who just played do NOT return to the queue at the same
  // instant: if they did, each would create their own wait and the veto's escape hatch would have
  // nobody to pair. The effect is visible here: whoever drew the wait is not in the queue yet.
  it("el que arrastra un retraso no entra a la cola hasta cumplirlo", async () => {
    vi.useFakeTimers();
    const { matchmaker, pool, cooldown } = build();
    cooldown.assign("mesa", ["u1", "u2"]); // 2 s y 7 s, sin barajar

    const search = matchmaker.request(CASUAL, requester("u2"), new AbortController().signal);
    search.catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pool.waiting("mesa")).toEqual([]);

    await vi.advanceTimersByTimeAsync(7_000);
    expect((await pool.waiting("mesa")).map((t) => t.playerId)).toEqual(["u2"]);
    vi.useRealTimers();
  });

  it("cancelar mientras cumple el retraso corta sin encolarlo", async () => {
    vi.useFakeTimers();
    const { matchmaker, pool, cooldown } = build();
    cooldown.assign("mesa", ["u1", "u2"]);
    const abort = new AbortController();

    const settled = matchmaker.request(CASUAL, requester("u2"), abort.signal).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    abort.abort();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await settled).toMatchObject({ reason: "CANCELLED" });
    expect(await pool.waiting("mesa")).toEqual([]);
    vi.useRealTimers();
  });

  it("el que no arrastra nada entra en el acto", async () => {
    const { matchmaker, pool } = build();

    void matchmaker.request(CASUAL, requester("u1"), new AbortController().signal).catch(() => {});
    await enqueued();

    expect((await pool.waiting("mesa")).map((t) => t.playerId)).toEqual(["u1"]);
  });
});

describe("Matchmaker: las salidas que no son una partida", () => {
  it("cancelar saca de la cola y rechaza con CANCELLED", async () => {
    const { matchmaker, pool } = build();
    const abort = new AbortController();

    const search = matchmaker.request(CASUAL, requester("u1"), abort.signal);
    const settled = search.catch((e) => e);
    await enqueued();
    abort.abort();

    expect(await settled).toMatchObject({ reason: "CANCELLED" });

    expect(await pool.waiting("mesa")).toEqual([]);
  });

  // Cancelling travels down the SAME socket as the request and can tread on its heels: asking the
  // scope takes a few awaits, and in that gap the signal can abort. An already-aborted signal does
  // not notify whoever attaches afterwards, so without checking, the ticket would sit in the queue
  // and the client would wait until the search timed out.
  it("cancelar ANTES de que termine de encolar también corta", async () => {
    const { matchmaker, pool } = build();
    const abort = new AbortController();

    const search = matchmaker.request(CASUAL, requester("u1"), abort.signal);
    const settled = search.catch((e) => e);
    abort.abort(); // en el acto, sin darle tiempo a nada
    await enqueued();

    expect(await settled).toMatchObject({ reason: "CANCELLED" });
    expect(await pool.waiting("mesa")).toEqual([]);
  });

  // Without a search timeout, a player alone at their table waits indefinitely.
  it("vencido el plazo, rechaza con TIMEOUT y lo saca de la cola", async () => {
    vi.useFakeTimers();
    const { matchmaker, pool } = build();

    const search = matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);
    const settled = search.catch((e) => e);
    await vi.advanceTimersByTimeAsync(DEFAULT_MATCHMAKING_CONFIG.searchTimeoutMs + 1);

    expect(await settled).toMatchObject({ reason: "TIMEOUT" });
    expect(await pool.waiting("mesa")).toEqual([]);
    vi.useRealTimers();
  });

  it("lo que el ámbito rechaza no llega a la cola", async () => {
    const { matchmaker, pool } = build({
      admit: async () => {
        throw new MatchmakingError("INSUFFICIENT_FUNDS");
      },
    });

    await expect(
      matchmaker.request(CASUAL, requester("pelado"), new AbortController().signal),
    ).rejects.toMatchObject({ reason: "INSUFFICIENT_FUNDS" });
    expect(await pool.waiting("mesa")).toEqual([]);
  });

  // If opening the match fails, whoever was waiting did nothing wrong: they go back to the queue with
  // their timeout still running, instead of taking a refusal over a problem of the server's.
  it("si no se puede abrir la partida, vuelven a la cola", async () => {
    const { matchmaker, gateway, pool } = build();
    gateway.setFailing(true);
    const signal = new AbortController().signal;

    void matchmaker.request(CASUAL, requester("u1"), signal).catch(() => {});
    void matchmaker.request(CASUAL, requester("u2"), signal).catch(() => {});
    await enqueued();
    await matchmaker.tick();

    expect(gateway.opened).toEqual([]);
    expect((await pool.waiting("mesa")).map((t) => t.playerId).sort()).toEqual(["u1", "u2"]);
  });

  // Con un motivo PROPIO y no el comodín: no falló nada y volver a pedir funciona, así que el cliente
  // reintenta cuando el servidor vuelva en vez de mostrar un error que no puede resolver.
  it("apagar el servidor cierra a los que estaban esperando, diciendo que es un reinicio", async () => {
    const { matchmaker } = build();

    const search = matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);
    const settled = search.catch((e) => e);
    await enqueued();
    matchmaker.stop();

    expect(await settled).toMatchObject({ reason: "RESTARTING" });
  });
});

// SINGLE SESSION: one active match per account. It falls to the matcher, because it is what decides
// whether someone enters a new table. What makes it tolerable is that the answer is not a "no":
// whoever is already playing is handed the seat of THEIR match, so reopening the app takes them back
// to the table with the client having stored nothing.
describe("Matchmaker: una partida activa por cuenta", () => {
  it("el que ya está jugando recibe la reserva de SU partida, y no entra a la cola", async () => {
    const { matchmaker, gateway, pool, live } = build();
    live.set("u1", "sala-viva");

    const seat = await matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);

    expect(seat).toEqual({ playerId: "u1", reservation: { roomId: "sala-viva", playerId: "u1" } });
    // Nothing new was opened and the queue is untouched: there is no ghost ticket waiting on a rival.
    expect(gateway.opened).toEqual([]);
    expect(await pool.waiting("mesa")).toEqual([]);
  });

  it("no le pregunta nada al ámbito: no va a entrar a una mesa nueva", async () => {
    const admit = vi.fn(async () => {});
    const { matchmaker, live } = build({ admit });
    live.set("u1", "sala-viva");

    await matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);

    // Asking about a balance or an enrolment is a network call, and there is nothing to authorise
    // here.
    expect(admit).not.toHaveBeenCalled();
  });

  it("si no hay asiento que darle —sigue conectado en otro lado— se rechaza", async () => {
    const { matchmaker, gateway, live } = build();
    live.set("u1", "sala-viva");
    gateway.rejoinable = false;

    await expect(
      matchmaker.request(CASUAL, requester("u1"), new AbortController().signal),
    ).rejects.toMatchObject({ reason: "ALREADY_IN_MATCH" });
  });

  it("el que NO está jugando sigue el camino normal", async () => {
    const { matchmaker, gateway, live } = build();
    live.set("otro", "sala-viva");

    const first = matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);
    await enqueued();
    const second = matchmaker.request(CASUAL, requester("u2"), new AbortController().signal);
    await Promise.all([first, second]);

    expect(gateway.opened).toHaveLength(1);
  });
});

// MAINTENANCE: how access to the game is cut without a deploy. What is tested here is the DOOR; the
// sign that explains it comes out of its own endpoint.
const CERRADO: Maintenance = { isUnderMaintenance: true, message: "volvemos a las 18" };

describe("Matchmaker: mantenimiento", () => {
  it("no deja entrar a una partida nueva", async () => {
    const { matchmaker, maintenance, gateway } = build();
    maintenance.set(CERRADO);

    await expect(
      matchmaker.request(CASUAL, requester("u1"), new AbortController().signal),
    ).rejects.toMatchObject({ reason: "MAINTENANCE" });
    // And they are not left queued waiting for it to reopen: the refusal is the answer, not a wait.
    await matchmaker.tick();
    expect(gateway.opened).toEqual([]);
  });

  // What closes is ENTRY and not the way back. Whoever is already playing has paid their entry fee
  // and their table will end anyway — maintenance kills no rooms — so refusing them re-entry would
  // leave them losing on time.
  it("devuelve igual a su partida en curso al que ya estaba jugando", async () => {
    const { matchmaker, live, maintenance } = build();
    live.set("u1", "sala-viva");
    maintenance.set(CERRADO);

    const seat = await matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);

    expect(seat.reservation).toMatchObject({ roomId: "sala-viva" });
  });

  it("con el interruptor abierto no cambia nada", async () => {
    const { matchmaker, gateway } = build();

    const first = matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);
    const second = matchmaker.request(CASUAL, requester("u2"), new AbortController().signal);
    await Promise.all([first, second]);

    expect(gateway.opened).toHaveLength(1);
  });
});

// THE OTHER HALF: the door stops people GETTING IN, this takes out those already inside. Without it,
// closing the game would leave the tick pairing up whoever queued a second earlier.
describe("Matchmaker: el mantenimiento vacía las colas", () => {
  it("a los que esperaban les llega la razón, en vez de un silencio de dos minutos", async () => {
    const { matchmaker, maintenance } = build();
    matchmaker.start();
    const waiting = matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);
    await enqueued();

    maintenance.set(CERRADO);

    await expect(waiting).rejects.toMatchObject({ reason: "MAINTENANCE" });
    matchmaker.stop();
  });

  // The TICKET leaves the queue and not only the promise. If it stayed, the next tick would pair it
  // with whoever came later — and the player already got their refusal, so they would be in two
  // places at once.
  it("y el ticket sale de la cola, no solo su promesa", async () => {
    const { matchmaker, maintenance, pool } = build();
    matchmaker.start();
    const waiting = matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);
    await enqueued();
    expect(await pool.waiting("mesa")).toHaveLength(1);

    maintenance.set(CERRADO);
    await expect(waiting).rejects.toMatchObject({ reason: "MAINTENANCE" });

    expect(await pool.waiting("mesa")).toEqual([]);
    matchmaker.stop();
  });

  // THE REAL SEQUENCE: one waiting when it closes, and another arriving afterwards. Without the
  // emptying, the second would have been paired with the first — who is no longer watching the
  // screen — and a table would have opened mid-maintenance, with its entry fee charged.
  it("el que llega después se topa con la puerta, y no hay con quién emparejarlo", async () => {
    const { matchmaker, maintenance, gateway } = build();
    matchmaker.start();
    const early = matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);
    await enqueued();

    maintenance.set(CERRADO);
    await expect(early).rejects.toMatchObject({ reason: "MAINTENANCE" });

    const late = matchmaker.request(CASUAL, requester("u2"), new AbortController().signal);
    await expect(late).rejects.toMatchObject({ reason: "MAINTENANCE" });

    await matchmaker.tick();
    expect(gateway.opened).toEqual([]);
    matchmaker.stop();
  });

  // REOPENING empties nothing: the queue was emptied on closing, and throwing someone out here would
  // throw out precisely those who queued because the game came back.
  it("volver a abrir deja emparejar de nuevo", async () => {
    const { matchmaker, maintenance, gateway } = build();
    matchmaker.start();
    maintenance.set(CERRADO);
    await expect(
      matchmaker.request(CASUAL, requester("u1"), new AbortController().signal),
    ).rejects.toMatchObject({ reason: "MAINTENANCE" });

    maintenance.set(OPEN);
    const first = matchmaker.request(CASUAL, requester("u1"), new AbortController().signal);
    const second = matchmaker.request(CASUAL, requester("u2"), new AbortController().signal);
    await Promise.all([first, second]);

    expect(gateway.opened).toHaveLength(1);
    matchmaker.stop();
  });

  // A stopped matcher releases its listener. Without this, it would keep reacting to a signal that
  // outlives it.
  it("un matcher detenido deja de escuchar el interruptor", async () => {
    const { matchmaker, maintenance } = build();
    matchmaker.start();
    matchmaker.stop();

    // It neither blows up nor touches anything: there is no listener left.
    expect(() => maintenance.set(CERRADO)).not.toThrow();
  });
});
