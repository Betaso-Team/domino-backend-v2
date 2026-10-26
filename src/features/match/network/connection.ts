// LA CONEXIÓN DE CADA ASIENTO: qué se mide, qué se anota y cómo se juzga una caída.
//
// No es regla de juego —no vive en `core/rules/`—: es un hecho de PLATAFORMA que el panel lee para
// contestar de quién fue la culpa de una caída. Lo mide el SERVIDOR (`ws.ping`, el monitor de la sala)
// y nunca el cliente, que podría inventar su ping. Diseño:
// `docs/superpowers/specs/2026-10-26-conexion-ping-y-culpa-de-las-caidas-design.md`.

/** Cada cuánto se sondea cada socket. */
export const PROBE_INTERVAL_MS = 2_000;
/** Cuántos sondeos recientes viajan congelados con cada caída (~20 s). */
export const RECENT_SAMPLES = 10;
/** Mediana de ping desde la que una conexión se considera lenta. */
export const HIGH_RTT_MS = 300;
/** Fluctuación (RFC 3550) desde la que una conexión se considera inestable. */
export const HIGH_JITTER_MS = 100;
/** Sondeos perdidos en la ventana reciente desde los que una conexión se considera mala. */
export const LOST_PROBES_POOR = 3;
/**
 * Cuántos OTROS jugadores conectados al proceso hacen falta para decir «a todos se les fue el ping».
 * En una mesa de dos el único otro es el rival, y que él también tenga mal internet no prueba nada.
 */
export const MIN_PEERS_FOR_OVERLOAD = 3;
/** p99 del event loop desde el que el servidor estaba trabado. */
export const EVENT_LOOP_LAG_MS = 500;
/** Tope de hechos por asiento: una partida con un jugador inestable no infla el registro. */
export const MAX_CONNECTION_EVENTS = 50;
/** Con qué regla se juzgó. Si la regla cambia, sube, y el panel sabe qué leyó. */
export const CONNECTION_VERDICT_VERSION = 1;

export type ConnectionBlame = "OURS" | "NETWORK" | "INTENTIONAL" | "UNKNOWN";
export type ConnectionCause =
  | "SERVER_SHUTDOWN"
  | "SERVER_OVERLOAD"
  | "SERVER_ERROR"
  | "LEFT_THE_TABLE"
  | "CLOSED_APP"
  | "WENT_OFFLINE"
  | "POOR_CONNECTION"
  | "CONNECTION_LOST"
  | "UNKNOWN_CLOSE";

export interface ConnectionVerdict {
  readonly blame: ConnectionBlame;
  readonly cause: ConnectionCause;
  readonly verdictVersion: typeof CONNECTION_VERDICT_VERSION;
}

/** Cómo estaba el servidor en el instante de la caída. */
export interface ServerHealth {
  readonly eventLoopP99Ms: number;
  /**
   * Cuántos de los OTROS jugadores conectados AL PROCESO —de esta mesa y de las demás— tenían el ping
   * alto en ese momento. Si el que falla es el servidor o su red, les pasa a todos a la vez.
   */
  readonly othersWithHighRtt: number;
  readonly othersConnected: number;
  readonly shuttingDown: boolean;
}

export interface DropEvidence {
  readonly closeCode: number | null;
  /** El jugador volvió con otra sesión antes de que el transporte notara muerta la vieja. */
  readonly replacedBySession: boolean;
  /** Los últimos sondeos hasta el último pong; `null` es uno perdido. */
  readonly recentRttMs: readonly (number | null)[];
  readonly jitterMs: number;
  readonly server: ServerHealth;
}

export interface RttSummary {
  readonly samples: number;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly jitterMs: number;
  readonly lostProbes: number;
}

/** Un hecho de conexión. `at` en epoch ms; el adaptador lo guarda como fecha. */
export type ConnectionEvent =
  | {
      readonly kind: "DROPPED";
      readonly at: number;
      readonly roundNumber: number;
      readonly closeCode: number | null;
      readonly replacedBySession?: true;
      readonly sinceLastPongMs: number | null;
      readonly recentRttMs: readonly (number | null)[];
      readonly server: ServerHealth;
      readonly verdict: ConnectionVerdict;
    }
  | {
      readonly kind: "RECONNECTED";
      readonly at: number;
      readonly roundNumber: number;
      readonly awayMs: number;
    }
  | {
      readonly kind: "GONE";
      readonly at: number;
      readonly roundNumber: number;
      readonly closeCode: number | null;
      /** Vino después de una caída: el veredicto es el de ese `DROPPED`. */
      readonly afterDrop?: true;
      readonly verdict?: ConnectionVerdict;
    };

export interface SeatConnection {
  readonly rtt: RttSummary;
  readonly events: readonly ConnectionEvent[];
  readonly truncated?: true;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/** La mediana de lo contestado llega a `HIGH_RTT_MS`. Sin muestras no hay nada que llamar alto. */
export function isHighRtt(recentRttMs: readonly (number | null)[]): boolean {
  const answered = recentRttMs.filter((rtt): rtt is number => rtt !== null);
  return answered.length > 0 && median(answered) >= HIGH_RTT_MS;
}

export function isPoorConnection(
  recentRttMs: readonly (number | null)[],
  jitterMs: number,
): boolean {
  const lost = recentRttMs.filter((rtt) => rtt === null).length;
  return isHighRtt(recentRttMs) || jitterMs >= HIGH_JITTER_MS || lost >= LOST_PROBES_POOR;
}

const verdict = (blame: ConnectionBlame, cause: ConnectionCause): ConnectionVerdict => ({
  blame,
  cause,
  verdictVersion: CONNECTION_VERDICT_VERSION,
});

// EL ORDEN ES LA DECISIÓN: lo nuestro se pregunta primero, porque culpar al jugador de lo que fue del
// servidor es lo único que este veredicto no puede hacer. Un `1006` en pleno apagado es nuestro.
export function connectionVerdictOf(evidence: DropEvidence): ConnectionVerdict {
  const { closeCode, server } = evidence;
  // `4010` SOLO NO ALCANZA para decir apagado: el SDK lo manda él mismo cuando el navegador dispara
  // `offline` (`@colyseus/sdk/build/Connection.mjs:28`). Lo que dice apagado es la marca de la sala.
  if (server.shuttingDown || closeCode === 4001) return verdict("OURS", "SERVER_SHUTDOWN");
  const everyoneLagged =
    server.othersConnected >= MIN_PEERS_FOR_OVERLOAD &&
    server.othersWithHighRtt * 2 >= server.othersConnected;
  if (server.eventLoopP99Ms >= EVENT_LOOP_LAG_MS || everyoneLagged)
    return verdict("OURS", "SERVER_OVERLOAD");
  if (closeCode === 4002) return verdict("OURS", "SERVER_ERROR");
  if (closeCode === 4000) return verdict("INTENTIONAL", "LEFT_THE_TABLE");
  // `1001` es cerrar la pestaña o la app, pero también RECARGAR: si después hay un `RECONNECTED`,
  // fue eso. El veredicto no se reescribe; el panel lo lee en la línea siguiente.
  if (closeCode === 1000 || closeCode === 1001) return verdict("INTENTIONAL", "CLOSED_APP");
  if (closeCode === 4010) return verdict("NETWORK", "WENT_OFFLINE");
  if (closeCode === 1005 || closeCode === 1006 || evidence.replacedBySession)
    return isPoorConnection(evidence.recentRttMs, evidence.jitterMs)
      ? verdict("NETWORK", "POOR_CONNECTION")
      : verdict("NETWORK", "CONNECTION_LOST");
  return verdict("UNKNOWN", "UNKNOWN_CLOSE");
}
