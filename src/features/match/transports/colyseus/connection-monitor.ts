import type { PlayerId } from "../../core/ids";
import {
  type ConnectionEvent,
  MAX_CONNECTION_EVENTS,
  RECENT_SAMPLES,
  type SeatConnection,
  type ServerHealth,
  connectionVerdictOf,
  isHighRtt,
} from "../../network/connection";

// EL PING DE CADA ASIENTO, MEDIDO DESDE EL SERVIDOR. El transporte ya le hace ping a cada socket cada
// 3 s, pero sólo para cortar al que no contesta: no mide nada. Acá se manda un ping de WebSocket
// PROPIO, con un nonce de payload, y el `pong` lo devuelve: los del transporte van sin payload, así
// que los nuestros se distinguen por construcción. El navegador y React Native contestan solos, en la
// capa de red, así que esto no le pide nada al front y el jugador no lo puede falsear.

/** Lo que el monitor necesita de un socket: el `WebSocket` de `ws` lo cumple tal cual. */
export interface ProbeSocket {
  ping(data: Buffer): void;
  on(event: "pong", listener: (data: Buffer) => void): unknown;
  off(event: "pong", listener: (data: Buffer) => void): unknown;
}

/**
 * El `client.ref` de Colyseus está tipado como `EventEmitter`. Con `ws` es un `WebSocket`; con otro
 * transporte (H3) no tiene `ping`, y ese asiento queda sin sonda en vez de reventar.
 */
export function probeSocketOf(ref: unknown): ProbeSocket | undefined {
  const socket = ref as Partial<ProbeSocket> | undefined;
  return typeof socket?.ping === "function" &&
    typeof socket.on === "function" &&
    typeof socket.off === "function"
    ? (socket as ProbeSocket)
    : undefined;
}

export interface ConnectionMonitorDeps {
  /** Reloj MONOTÓNICO para los RTT: un ajuste del reloj del sistema no fabrica un ping negativo. */
  readonly monotonicNow: () => number;
  /** Reloj de pared, para el `at` de cada hecho. */
  readonly wallNow: () => number;
  readonly eventLoopP99Ms: () => number;
}

interface DropContext {
  readonly closeCode: number | null;
  readonly roundNumber: number;
  readonly shuttingDown: boolean;
  readonly replacedBySession?: true;
}

interface Seat {
  socket?: ProbeSocket;
  listener?: (data: Buffer) => void;
  pending: { readonly nonce: number; readonly sentAt: number }[];
  /** Los últimos sondeos RESUELTOS: una muestra, o `null` si se perdió y llegó uno posterior. */
  recent: (number | null)[];
  samples: number;
  sumMs: number;
  maxMs: number;
  jitterMs: number;
  lastRttMs?: number;
  lostProbes: number;
  lastPongAt?: number;
  awaySince?: number;
  events: ConnectionEvent[];
  truncated: boolean;
}

const NONCE_BYTES = 4;

export class ConnectionMonitor {
  private readonly seats = new Map<PlayerId, Seat>();
  private nextNonce = 0;

  constructor(private readonly deps: ConnectionMonitorDeps) {}

  /**
   * El socket nuevo del asiento. Lo que se le mandó al anterior ya no cuenta. SE SONDEA EN EL ACTO: una
   * partida que se decide antes del primer intervalo —o una vuelta corta— queda con ping igual.
   */
  attach(playerId: PlayerId, socket: ProbeSocket): void {
    const seat = this.seatOf(playerId);
    this.detach(seat);
    const listener = (data: Buffer) => this.pong(seat, data);
    socket.on("pong", listener);
    seat.socket = socket;
    seat.listener = listener;
    seat.pending = [];
    this.probeSeat(seat);
  }

  probe(): void {
    for (const seat of this.seats.values()) this.probeSeat(seat);
  }

  dropped(playerId: PlayerId, context: DropContext): ConnectionEvent {
    const seat = this.seatOf(playerId);
    const server = this.serverHealth(playerId, context.shuttingDown);
    const recentRttMs = [...seat.recent];
    const event: ConnectionEvent = {
      kind: "DROPPED",
      at: this.deps.wallNow(),
      roundNumber: context.roundNumber,
      closeCode: context.closeCode,
      ...(context.replacedBySession ? { replacedBySession: true as const } : {}),
      sinceLastPongMs:
        seat.lastPongAt === undefined ? null : this.deps.monotonicNow() - seat.lastPongAt,
      recentRttMs,
      server,
      verdict: connectionVerdictOf({
        closeCode: context.closeCode,
        replacedBySession: context.replacedBySession === true,
        recentRttMs,
        jitterMs: seat.jitterMs,
        server,
      }),
    };
    this.detach(seat);
    seat.awaySince = event.at;
    return this.note(seat, event);
  }

  /** Sólo si el asiento estaba afuera; una entrada sin caída previa no es una vuelta. */
  reconnected(playerId: PlayerId, roundNumber: number): ConnectionEvent | undefined {
    const seat = this.seatOf(playerId);
    if (seat.awaySince === undefined) return undefined;
    const at = this.deps.wallNow();
    const awayMs = at - seat.awaySince;
    seat.awaySince = undefined;
    return this.note(seat, { kind: "RECONNECTED", at, roundNumber, awayMs });
  }

  // DESPUÉS DE UNA CAÍDA, `onLeave` llega con el código ORIGINAL de la caída (`Room.mjs:1466-1476`):
  // no hay evidencia nueva que juzgar, así que vale el veredicto del `DROPPED`.
  gone(playerId: PlayerId, context: Omit<DropContext, "replacedBySession">): ConnectionEvent {
    const seat = this.seatOf(playerId);
    const at = this.deps.wallNow();
    if (seat.awaySince !== undefined) {
      seat.awaySince = undefined;
      return this.note(seat, {
        kind: "GONE",
        at,
        roundNumber: context.roundNumber,
        closeCode: context.closeCode,
        afterDrop: true,
      });
    }
    const verdict = connectionVerdictOf({
      closeCode: context.closeCode,
      replacedBySession: false,
      recentRttMs: [...seat.recent],
      jitterMs: seat.jitterMs,
      server: this.serverHealth(playerId, context.shuttingDown),
    });
    this.detach(seat);
    return this.note(seat, {
      kind: "GONE",
      at,
      roundNumber: context.roundNumber,
      closeCode: context.closeCode,
      verdict,
    });
  }

  connectionOf(playerId: PlayerId): SeatConnection | undefined {
    const seat = this.seats.get(playerId);
    if (!seat) return undefined;
    return {
      rtt: {
        samples: seat.samples,
        avgMs: seat.samples === 0 ? 0 : Math.round(seat.sumMs / seat.samples),
        maxMs: seat.maxMs,
        jitterMs: Math.round(seat.jitterMs),
        lostProbes: seat.lostProbes,
      },
      events: [...seat.events],
      ...(seat.truncated ? { truncated: true as const } : {}),
    };
  }

  dispose(): void {
    for (const seat of this.seats.values()) this.detach(seat);
  }

  // UN SONDEO SIN RESPUESTA CUENTA PERDIDO SÓLO SI LLEGÓ UNO POSTERIOR. Los del final, después del
  // último pong, son la caída misma —el transporte tarda 6-9 s en notarla, o sea 3 o 4 sondeos— y
  // contarlos haría que toda caída se lea como mala conexión.
  private pong(seat: Seat, data: Buffer): void {
    const now = this.deps.monotonicNow();
    seat.lastPongAt = now;
    if (data.length !== NONCE_BYTES) return;
    const nonce = data.readUInt32BE();
    const index = seat.pending.findIndex((probe) => probe.nonce === nonce);
    if (index < 0) return;
    for (let lost = 0; lost < index; lost++) {
      seat.lostProbes++;
      this.remember(seat, null);
    }
    const rtt = now - (seat.pending[index] as { sentAt: number }).sentAt;
    seat.pending = seat.pending.slice(index + 1);
    // Fluctuación al estilo RFC 3550: lo mismo que el SDK llama `jitter()`, medido del lado que no
    // puede mentir.
    if (seat.lastRttMs !== undefined)
      seat.jitterMs += (Math.abs(rtt - seat.lastRttMs) - seat.jitterMs) / 16;
    seat.lastRttMs = rtt;
    seat.samples++;
    seat.sumMs += rtt;
    seat.maxMs = Math.max(seat.maxMs, rtt);
    this.remember(seat, rtt);
  }

  private probeSeat(seat: Seat): void {
    if (!seat.socket) return;
    const nonce = this.nextNonce;
    this.nextNonce = (this.nextNonce + 1) >>> 0;
    const data = Buffer.alloc(NONCE_BYTES);
    data.writeUInt32BE(nonce);
    seat.pending.push({ nonce, sentAt: this.deps.monotonicNow() });
    seat.socket.ping(data);
  }

  private remember(seat: Seat, rtt: number | null): void {
    seat.recent.push(rtt);
    if (seat.recent.length > RECENT_SAMPLES) seat.recent.shift();
  }

  // Si a TODOS se les fue el ping a la vez, el problema no está en la casa de uno.
  private serverHealth(playerId: PlayerId, shuttingDown: boolean): ServerHealth {
    const others = [...this.seats].filter(([id, seat]) => id !== playerId && seat.socket);
    return {
      eventLoopP99Ms: this.deps.eventLoopP99Ms(),
      othersWithHighRtt: others.filter(([, seat]) => isHighRtt(seat.recent)).length,
      othersConnected: others.length,
      shuttingDown,
    };
  }

  // SE QUEDAN LOS ÚLTIMOS: la caída que el panel necesita es la que terminó en retiro, o sea la
  // última, y es justo la del jugador inestable que llega al tope.
  private note(seat: Seat, event: ConnectionEvent): ConnectionEvent {
    seat.events.push(event);
    if (seat.events.length > MAX_CONNECTION_EVENTS) {
      seat.events.shift();
      seat.truncated = true;
    }
    return event;
  }

  private detach(seat: Seat): void {
    if (seat.socket && seat.listener) seat.socket.off("pong", seat.listener);
    seat.socket = undefined;
    seat.listener = undefined;
    seat.pending = [];
  }

  private seatOf(playerId: PlayerId): Seat {
    let seat = this.seats.get(playerId);
    if (!seat) {
      seat = {
        pending: [],
        recent: [],
        samples: 0,
        sumMs: 0,
        maxMs: 0,
        jitterMs: 0,
        lostProbes: 0,
        events: [],
        truncated: false,
      };
      this.seats.set(playerId, seat);
    }
    return seat;
  }
}
