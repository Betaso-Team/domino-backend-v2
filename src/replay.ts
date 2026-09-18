import type { GlobalDominoConfig, TeamAssignmentMode } from "@/features/match/core/config";
import { replay } from "@/features/match/history/replay";
import type { HistoryEntry, HistoryReader } from "@/features/match/network/history";
import { replayConfigOf } from "@/features/match/transports/match-contract";
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
import { mongo, rootContainer } from "./di-container";
import { logger } from "./logger";

const USAGE =
  "uso: npm run replay -- <matchId> <seed> <pointsToWin> <SHUFFLED|SEAT_ORDER> <asiento...>";

// El meta VA POR ARGUMENTOS, y ya no es porque falte la persistencia: la persistencia
// existe, pero graba una sola colección —`match_history`, las entradas— y NO una
// `match_meta`. Es una decisión, no un pendiente: el `seed` no está en el historial a
// propósito (una entrada es un acto o un hecho, y el seed no es ninguno de los dos), y una
// colección de cabeceras que hoy nadie escribiría al cerrar la partida sería un lugar vacío
// donde el operador va a buscar. Mientras el único productor de partidas sea el arnés, los
// cinco valores se saben.
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

// EL CONFIG SALE DE `replayConfigOf` Y NO SE ARMA A MANO. Escrito a mano decía "igual que en
// `configOf`" en un comentario, que es la misma regla en dos lugares obligada a coincidir
// sin que nada lo verifique. Un campo nuevo en `DominoMatchConfig`, o el día que
// `isDealWindowEnabled` deje de estar siempre encendida, le daban al CLI una partida
// distinta de la que la sala jugó, en silencio y sin que tsc dijera nada.
//
// ⛔ Y ES `replayConfigOf` Y NO `configOf`, QUE ES LA MITAD DE LA TAREA 10. Desde que el catálogo
// es la autoridad, `configOf` pide el `GameMode` resuelto: usarlo acá obligaría al CLI de soporte
// a consultar Mongo —o peor, a consultarlo y encontrar el modo YA EDITADO—, y entonces rebobinar
// una partida vieja la reconstruiría con los puntos y el premio de hoy. Una partida se rebobina
// con el snapshot que TENÍA. Por eso este archivo no importa nada de `features/game-mode`, y hay
// un test que lo mide sobre la lista exacta de imports.
//
// LOS ASIENTOS SON SINTÉTICOS Y NO LO DISIMULAN. Los argumentos posicionales siguen
// siendo IDS DE ASIENTO —el vocabulario con el que el historial grabó la partida—, y el
// resto del snapshot no está grabado en ninguna parte: `match_history` guarda actos y
// hechos, no la cabecera de la mesa. `platformId: "replay"` y `currency: "REPLAY"` son
// etiquetas que gritan de dónde salieron, y los montos van en cero con la tasa nula.
//
// ⛔ NADA DE ESTO SIRVE PARA LIQUIDAR. Estos campos completan un `DominoMatchConfig` que el
// motor necesita entero pero cuyo dinero NO consume: la reconstrucción del árbol no lee
// moneda, tasa ni montos. Usar este config para calcular una recompensa pagaría en una
// moneda que no existe, a una tasa que nadie aceptó.
//
// EL `playerId` SE NUMERA ACÁ, y es exactamente lo que `configOf` hacía antes: `seat-1`, `seat-2`,
// … EN ORDEN DE ARGUMENTO. Es el id OPACO con el que el motor y el historial nombran a cada
// jugador, así que tomarlo del argumento en vez de numerarlo cambiaría de asiento a cualquiera que
// invoque el CLI con otra etiqueta y rebobinaría la partida con las manos cruzadas.
const snapshot = {
  matchId,
  gameModeId: "replay",
  seats: seats.map((userUuid, index) => ({
    platformId: "replay",
    userUuid,
    displayName: userUuid,
    currency: "REPLAY",
    playerId: `seat-${index + 1}`,
  })),
  seed,
  pointsToWin,
  teamAssignment,
  isDealWindowEnabled: true,
  rateId: "00000000-0000-4000-8000-000000000000",
  entryFee: 0,
  prize: 0,
};

logger.info("rebobinando", { matchId, entries: entries.length });
const state = replay({
  meta: replayConfigOf(snapshot),
  // El MISMO `globalConfig` que el container del proceso derivó de `env`. Sin esto el
  // replay caía a `DEFAULT_GLOBAL_CONFIG` y le estampaba a una partida real plazos que
  // nunca tuvo —y un `extraTimeRemainingMs` inventado, que es estado observable del árbol
  // impreso—. Es el mismo riesgo que `writeGolden` ya había cerrado guardando el
  // `globalConfig` en el fixture; acá estaba abierto.
  globalConfig: rootContainer.resolve<GlobalDominoConfig>("GlobalDominoConfig"),
  // Sin `startedAt`: el instante de arranque no está grabado en ninguna parte —`begin()` no
  // emite, así que la primera entrada del historial ya es posterior—, y la persistencia no
  // lo cambió: graba `match_history` y no una `match_meta` (ver arriba). El replay cae al
  // `at` de la primera entrada, así que `startedAt` sigue siendo lo único del árbol impreso
  // que no es el de la partida real.
  entries,
});
logger.info("estado final reconstruido", { matchId, state: state.toJSON() });

// CERRAR LA CONEXIÓN ES LO QUE HACE QUE EL CLI TERMINE. El cliente de Mongo mantiene
// sockets abiertos y con ellos el event loop vivo, así que sin esto `npm run replay`
// imprime el estado final y se queda colgado sin decir por qué — el modo de falla más
// confuso posible para una herramienta de una sola corrida. El servidor no lo necesita
// porque no termina nunca.
//
// Con `?.` porque sin `MONGO_URI` no hay conexión que cerrar, y un `process.exit(0)` en su
// lugar no serviría: cortaría también el vaciado de los logs de pino, que es justamente la
// salida por la que se corre este comando.
await mongo?.close();
