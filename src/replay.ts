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
import type { GlobalDominoConfig, TeamAssignmentMode } from "./features/match/core/config.js";
import { replay } from "./features/match/history/replay.js";
import type { HistoryEntry, HistoryReader } from "./features/match/network/history.js";
import { type DominoRoomOptions, configOf } from "./features/match/transports/match-contract.js";
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

// Se acumulan TODOS los argumentos inválidos y se listan juntos. Con el `if` booleano que
// había, cinco argumentos mal daban el mismo USAGE genérico que uno solo, y el operador
// —que llega acá con una partida que no puede rebobinar— los descubría de a uno por
// corrida. No hay parser de argumentos de por medio a propósito: son cinco posiciones
// fijas, y una dependencia para esto es más superficie de la que ahorra.
const invalidos: string[] = [];
if (!matchId) invalidos.push("matchId: falta");
if (!seed) invalidos.push("seed: falta");
if (!Number.isInteger(pointsToWin) || pointsToWin <= 0) {
  invalidos.push(`pointsToWin: se esperaba un entero > 0, llegó "${process.argv[4] ?? ""}"`);
}
if (!isTeamAssignment(teamAssignment)) {
  invalidos.push(
    `teamAssignment: se esperaba SHUFFLED|SEAT_ORDER, llegó "${teamAssignment ?? ""}"`,
  );
}
// DOS asientos como mínimo, no uno: el dominó no tiene modo solitario, y con un solo
// asiento el reparto y el `teamAssignment` describen una mesa que nunca existió. El CLI
// aceptaba `seats.length === 0` como único rechazo, así que un asiento suelto llegaba
// hasta el motor y rebobinaba contra un config imposible.
if (seats.length < 2) invalidos.push(`asientos: se esperaban al menos 2, llegaron ${seats.length}`);

// `process.exit` devuelve `never`, así que salir por acá ESTRECHA los tipos abajo — pero
// solo para las condiciones escritas EN el `if`. `invalidos.length > 0` es opaco para tsc:
// no le dice nada sobre `matchId` ni sobre `teamAssignment`. Por eso las tres condiciones
// que estrechan se repiten: no es defensa duplicada —son inalcanzables con el arreglo
// vacío—, es lo que permite que el config de abajo se arme sin un solo cast.
if (invalidos.length > 0 || !matchId || !seed || !isTeamAssignment(teamAssignment)) {
  logger.error(USAGE, { invalidos });
  process.exit(1);
}

// DE DÓNDE SALE el historial lo decide el entorno del proceso, no este archivo: con
// `MONGO_URI` configurada el container cablea el adaptador de Mongo y esto rebobina una
// partida que jugó OTRO proceso, que es para lo que el CLI existe; sin ella cablea el de
// memoria, y entonces solo se ve lo que grabó esta misma corrida —o sea, nada—.
//
// `await` en el tope del módulo, sin envolver todo en un `main()`: el paquete es ESM
// (`"type": "module"` en package.json) y el archivo es un entrypoint, así que el
// top-level await es válido y no le agrega un nivel de indentación al script entero.
const entries: readonly HistoryEntry[] = await rootContainer
  .resolve<HistoryReader>("HistoryReader")
  .of(matchId);

if (entries.length === 0) {
  logger.error("no hay historial para esa partida", { matchId });
  process.exit(1);
}

// El config sale de `configOf` y NO se arma a mano acá. Escrito a mano decía "igual que en
// `configOf`" en un comentario, que es la misma regla en dos lugares obligada a coincidir
// sin que nada lo verifique — el smell exacto que esta tarea vino a cerrar en el grafo de
// actores. Un campo nuevo en `DominoMatchConfig`, o el día que `isDealWindowEnabled` deje
// de estar siempre encendida, le daban al CLI una partida distinta de la que la sala jugó,
// en silencio y sin que tsc dijera nada. Ahora la mesa se describe en el vocabulario de
// matchmaking (`DominoRoomOptions`) y la traducción la hace el único que sabe hacerla.
const options: DominoRoomOptions = {
  mode: "CASUAL",
  matchId,
  gameModeId: "replay",
  seats,
  seed,
  pointsToWin,
  teamAssignment,
};

logger.info("rebobinando", { matchId, entries: entries.length });
const state = replay({
  meta: configOf(options),
  // El MISMO `globalConfig` que el container del proceso derivó de `env`. Sin esto el
  // replay caía a `DEFAULT_GLOBAL_CONFIG` y le estampaba a una partida real plazos que
  // nunca tuvo —y un `extraTimeRemainingMs` inventado, que es estado observable del árbol
  // impreso—. Es el mismo riesgo que `writeGolden` ya había cerrado guardando el
  // `globalConfig` en el fixture; acá estaba abierto.
  globalConfig: rootContainer.resolve<GlobalDominoConfig>("GlobalDominoConfig"),
  // Sin `startedAt`: el instante de arranque vive en `match_meta`, que todavía no existe.
  // El replay cae al de la primera entrada, así que `startedAt` es lo único del árbol
  // impreso que no es el de la partida real.
  entries,
});
logger.info("estado final reconstruido", { matchId, state: state.toJSON() });
