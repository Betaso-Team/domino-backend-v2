import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ConnectionMonitor, type ProbeSocket, probeSocketOf } from "./connection-monitor";

// UN SOCKET DE MENTIRA que hace lo mismo que el `ws` de verdad en lo que importa: `ping(data)` y
// `pong` con el mismo payload. Contestar es emitir el `pong` con lo que se mandó.
class FakeSocket extends EventEmitter implements ProbeSocket {
  readonly ping = vi.fn<(data: Buffer) => void>();
  answer(probe: number): void {
    this.emit("pong", this.ping.mock.calls[probe]?.[0]);
  }
  answerLast(): void {
    this.answer(this.ping.mock.calls.length - 1);
  }
}

function build(lagMs = 12) {
  const time = { mono: 0, wall: 1_000_000 };
  const monitor = new ConnectionMonitor({
    monotonicNow: () => time.mono,
    wallNow: () => time.wall,
    eventLoopP99Ms: () => lagMs,
  });
  return { monitor, time };
}

const dropCtx = { closeCode: 1006, roundNumber: 1, shuttingDown: false } as const;

// Un sondeo contestado `rtt` ms después.
function sample(
  monitor: ConnectionMonitor,
  time: { mono: number },
  socket: FakeSocket,
  rtt: number,
) {
  monitor.probe();
  time.mono += rtt;
  socket.answerLast();
}

describe("ConnectionMonitor", () => {
  // UNA PARTIDA QUE TERMINA EN MENOS DE UN INTERVALO tiene que tener ping igual: el socket se sondea
  // en el acto de conectarse, y esa respuesta es la primera muestra.
  it("conectar el socket lo sondea en el acto, y la respuesta es una muestra", () => {
    const { monitor, time } = build();
    const socket = new FakeSocket();
    monitor.attach("seat-1", socket);

    time.mono += 80;
    socket.answerLast();

    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(monitor.connectionOf("seat-1")?.rtt).toEqual({
      samples: 1,
      avgMs: 80,
      maxMs: 80,
      jitterMs: 0,
      lostProbes: 0,
    });
  });

  it("la fluctuación sigue la fórmula de RFC 3550", () => {
    const { monitor, time } = build();
    const socket = new FakeSocket();
    monitor.attach("seat-1", socket);

    time.mono += 80;
    socket.answerLast();
    sample(monitor, time, socket, 112);

    expect(monitor.connectionOf("seat-1")?.rtt.jitterMs).toBe(2);
  });

  it("un sondeo sin respuesta cuenta perdido solo cuando llega uno posterior", () => {
    const { monitor, time } = build();
    const socket = new FakeSocket();
    monitor.attach("seat-1", socket);

    monitor.probe();
    monitor.probe();
    monitor.probe();
    time.mono += 50;
    socket.answer(2);

    expect(monitor.connectionOf("seat-1")?.rtt.lostProbes).toBe(2);
  });

  it("los sondeos sin respuesta del final son la caída misma, no mala conexión", () => {
    const { monitor, time } = build();
    const socket = new FakeSocket();
    monitor.attach("seat-1", socket);
    time.mono += 80;
    socket.answerLast();

    monitor.probe();
    monitor.probe();
    monitor.probe();
    const drop = monitor.dropped("seat-1", dropCtx);

    expect(monitor.connectionOf("seat-1")?.rtt.lostProbes).toBe(0);
    expect(drop).toMatchObject({ recentRttMs: [80], verdict: { cause: "CONNECTION_LOST" } });
  });

  it("la ventana guarda las últimas diez", () => {
    const { monitor, time } = build();
    const socket = new FakeSocket();
    monitor.attach("seat-1", socket);

    for (let rtt = 1; rtt <= 12; rtt++) sample(monitor, time, socket, rtt);
    const drop = monitor.dropped("seat-1", dropCtx);

    expect(drop.kind === "DROPPED" && drop.recentRttMs).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("pong del socket reemplazado", () => {
    const { monitor, time } = build();
    const old = new FakeSocket();
    monitor.attach("seat-1", old);
    monitor.probe();
    monitor.attach("seat-1", new FakeSocket());
    time.mono += 40;

    old.answer(0);

    expect(monitor.connectionOf("seat-1")?.rtt.samples).toBe(0);
  });

  it("el pong del transporte no es muestra pero cuenta como señal de vida", () => {
    const { monitor, time } = build();
    const socket = new FakeSocket();
    monitor.attach("seat-1", socket);

    time.mono = 500;
    socket.emit("pong", Buffer.alloc(0));
    time.mono = 700;
    const drop = monitor.dropped("seat-1", dropCtx);

    expect(monitor.connectionOf("seat-1")?.rtt.samples).toBe(0);
    expect(drop).toMatchObject({ sinceLastPongMs: 200 });
  });

  it("caída antes del primer pong", () => {
    const { monitor } = build();
    monitor.attach("seat-1", new FakeSocket());

    const drop = monitor.dropped("seat-1", dropCtx);

    expect(monitor.connectionOf("seat-1")?.rtt).toMatchObject({ samples: 0, avgMs: 0, maxMs: 0 });
    expect(drop).toMatchObject({
      sinceLastPongMs: null,
      verdict: { blame: "NETWORK", cause: "CONNECTION_LOST" },
    });
  });

  it("la caída lleva la salud del servidor", () => {
    const { monitor, time } = build(30);
    const mine = new FakeSocket();
    const rival = new FakeSocket();
    monitor.attach("seat-1", mine);
    monitor.attach("seat-2", rival);
    monitor.probe();
    time.mono += 400;
    rival.answerLast();

    const drop = monitor.dropped("seat-1", dropCtx);

    expect(drop).toMatchObject({
      server: { eventLoopP99Ms: 30, othersWithHighRtt: 1, othersConnected: 1, shuttingDown: false },
      verdict: { blame: "OURS", cause: "SERVER_OVERLOAD" },
    });
  });

  it("caída, vuelta y salida definitiva", () => {
    const { monitor, time } = build();
    monitor.attach("seat-1", new FakeSocket());

    time.wall = 10_000;
    monitor.dropped("seat-1", dropCtx);
    time.wall = 13_000;
    const back = monitor.reconnected("seat-1", 1);
    monitor.attach("seat-1", new FakeSocket());
    monitor.dropped("seat-1", dropCtx);
    const gone = monitor.gone("seat-1", dropCtx);

    expect(back).toEqual({ kind: "RECONNECTED", at: 13_000, roundNumber: 1, awayMs: 3_000 });
    expect(gone).toEqual({
      kind: "GONE",
      at: 13_000,
      roundNumber: 1,
      closeCode: 1006,
      afterDrop: true,
    });
    expect(monitor.connectionOf("seat-1")?.events.map((event) => event.kind)).toEqual([
      "DROPPED",
      "RECONNECTED",
      "DROPPED",
      "GONE",
    ]);
  });

  it("una salida sin caída lleva su propio veredicto", () => {
    const { monitor } = build();
    monitor.attach("seat-1", new FakeSocket());

    const gone = monitor.gone("seat-1", { ...dropCtx, closeCode: 4000 });

    expect(gone).toMatchObject({ verdict: { blame: "INTENTIONAL", cause: "LEFT_THE_TABLE" } });
    expect(gone).not.toHaveProperty("afterDrop");
  });

  it("vuelta sin caída no anota nada", () => {
    const { monitor } = build();
    monitor.attach("seat-1", new FakeSocket());

    expect(monitor.reconnected("seat-1", 1)).toBeUndefined();
    expect(monitor.connectionOf("seat-1")?.events).toEqual([]);
  });

  it("tope de hechos", () => {
    const { monitor } = build();
    monitor.attach("seat-1", new FakeSocket());

    for (let i = 0; i < 26; i++) {
      monitor.dropped("seat-1", dropCtx);
      monitor.reconnected("seat-1", 1);
    }

    const connection = monitor.connectionOf("seat-1");
    expect(connection?.events).toHaveLength(50);
    expect(connection?.truncated).toBe(true);
  });

  it("un asiento que nunca tuvo socket no tiene conexión", () => {
    const { monitor } = build();
    expect(monitor.connectionOf("seat-9")).toBeUndefined();
  });

  it("dispose suelta los listeners", () => {
    const { monitor } = build();
    const socket = new FakeSocket();
    monitor.attach("seat-1", socket);

    monitor.dispose();

    expect(socket.listenerCount("pong")).toBe(0);
  });

  it("probeSocketOf rechaza lo que no es un ws", () => {
    expect(probeSocketOf({})).toBeUndefined();
    expect(probeSocketOf(undefined)).toBeUndefined();
    const socket = new FakeSocket();
    expect(probeSocketOf(socket)).toBe(socket);
  });
});
