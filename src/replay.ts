// npm run replay -- <matchId> <seed> <pointsToWin> <teamAssignment> <asiento...>
//
// Rebobina la partida desde el historial e IMPRIME el estado final reconstruido. Es la
// herramienta de SOPORTE: no afirma nada, porque el historial no lleva un snapshot contra
// el que comparar —y no lo lleva a propósito, ver abajo—.
//
// El que AFIRMA es `replay.test.ts`, contra los fixtures golden: ahí el estado final
// esperado vive en el propio fixture (`finalState`), versionado en el repo y aprobado a
// ojo una vez. Ése es el test de regresión del motor.
//
// Por qué el snapshot no está en `match_history`: una entrada del historial es un ACTO o
// un HECHO, las dos cosas inmutables y de tamaño acotado. Un snapshot del árbol es otra
// clase de cosa —un volcado, grande, y solo interesante al cierre—, así que si alguna vez
// hace falta va en `match_meta` al cerrar la partida, no colgado de una entrada. Un campo
// opcional que nadie escribe es peor que no tenerlo: hace creer que el replay puede
// autoverificarse contra producción cuando no puede.
import { rootContainer } from "./di-container.js";
import type { TeamAssignmentMode } from "./features/match/core/config.js";
import { replay } from "./features/match/history/replay.js";
import type { HistoryEntry } from "./features/match/network/history.js";
import type { MemoryHistory } from "./features/match/network/transports/memory-history.js";
import { logger } from "./logger.js";

const USAGE =
  "uso: npm run replay -- <matchId> <seed> <pointsToWin> <SHUFFLED|SEAT_ORDER> <asiento...>";

// El meta sale de `match_meta` cuando exista la persistencia; hasta entonces va por
// argumentos, porque el `seed` NO está en el historial a propósito.
//
// Los cuatro son OBLIGATORIOS y no tienen default. El `pointsToWin` sobre todo: el
// veredicto de la partida depende de él —entrar en PRESENTING_MATCH es alcanzarlo—, así
// que un valor inventado no reproduce el final. Con 0, además, `teamA >= 0` es verdadero
// desde el arranque y la partida cerraría en la primera comprobación. El `teamAssignment`
// tampoco es adorno: con `SHUFFLED` las parejas salen de sortear los asientos con el
// seed, así que asumir `SEAT_ORDER` reparte los puntos al equipo equivocado.
const matchId = process.argv[2];
const seed = process.argv[3];
const pointsToWin = Number(process.argv[4]);
const teamAssignment = process.argv[5];
const seats = process.argv.slice(6);

function isTeamAssignment(value: string | undefined): value is TeamAssignmentMode {
  return value === "SHUFFLED" || value === "SEAT_ORDER";
}

if (
  !matchId ||
  !seed ||
  !Number.isInteger(pointsToWin) ||
  pointsToWin <= 0 ||
  !isTeamAssignment(teamAssignment) ||
  seats.length === 0
) {
  logger.error(USAGE);
  process.exit(1);
}

// Con la implementación de memoria esto solo sirve dentro del mismo proceso; el
// adaptador de Mongo lo vuelve útil desde la consola.
const entries: readonly HistoryEntry[] = (rootContainer.resolve("HistoryPort") as MemoryHistory).of(
  matchId,
);

if (entries.length === 0) {
  logger.error("no hay historial para esa partida", { matchId });
  process.exit(1);
}

logger.info("rebobinando", { matchId, entries: entries.length });
const state = replay({
  meta: {
    matchId,
    gameModeId: "replay",
    seed,
    seats,
    pointsToWin,
    teamAssignment,
    // Igual que en `configOf`: la ventana de reparto está encendida en TODA mesa, porque
    // es control de presencia anti-fraude y no una opción del modo. Con `false` el motor
    // del replay arrancaría en `PLAYING` y los `REVEAL_TILES` del historial caerían con
    // `NOT_DEALING` — es decir, no reproduciría nada.
    isDealWindowEnabled: true,
  },
  // Sin `startedAt`: el instante de arranque vive en `match_meta`, que todavía no existe.
  // El replay cae al de la primera entrada, así que `startedAt` es lo único del árbol
  // impreso que no es el de la partida real.
  entries,
});
logger.info("estado final reconstruido", { matchId, state: state.toJSON() });
