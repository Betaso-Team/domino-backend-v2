import type { GlobalDominoConfig, TeamAssignmentMode } from "@/features/match/core/config";
import { recordedReplayOf } from "@/features/match/history/recorded";
import { type ReplayInput, replay } from "@/features/match/history/replay";
import type { HistoryEntry, HistoryReader, MatchArchive } from "@/features/match/network/history";
import { replayConfigOf } from "@/features/match/transports/match-contract";
// npm run replay -- <matchId>
// npm run replay -- <matchId> <seed> <pointsToWin> <teamAssignment> <asiento...>
//
// Rebobina la partida desde el historial e IMPRIME el estado final reconstruido. Es la
// herramienta de SOPORTE: no afirma nada, porque el historial no lleva un snapshot contra
// el que comparar —y no lo lleva a propósito, ver abajo—.
//
// El que AFIRMA es `replay.int.test.ts`, contra los fixtures golden: ahí el estado final
// esperado vive en el propio fixture (`finalState`), versionado en el repo y aprobado a
// ojo una vez. Ése es el test de regresión del motor.
//
// Por qué el snapshot del árbol no está en `match_history`: una entrada del historial es un ACTO o
// un HECHO, las dos cosas inmutables y de tamaño acotado, y la cabecera del registro es el ARMADO.
// Un volcado del árbol es otra clase de cosa —grande, y solo interesante al cierre—. Un campo
// opcional que nadie escribe es peor que no tenerlo: hace creer que el replay puede
// autoverificarse contra producción cuando no puede.
import { mongo, rootContainer } from "./di-container";
import { flushLogs, logger } from "./logger";

const USAGE =
  "uso: npm run replay -- <matchId> [<seed> <pointsToWin> <SHUFFLED|SEAT_ORDER> <asiento...>]";

// EL META SALE DEL REGISTRO cuando se pasa sólo el `matchId`. Desde la v2.1 el documento de
// `match_history` guarda la cabecera de la mesa al arrancar —el seed, las parejas, los asientos,
// los plazos, el marcador inicial y las reglas— (`features/match/history/recorded.ts`), que es lo
// que antes este CLI tenía que pedir por argumentos: el `seed` no es un acto ni un hecho, así que
// no estaba en ninguna entrada, y una colección de cabeceras aparte habría sido un lugar vacío
// donde el operador iba a buscar.
//
// LOS ARGUMENTOS SIGUEN, para los documentos de la forma vieja —`{ matchId, entries }`, sin
// cabecera— y para la partida que nunca llegó a abrir. Ahí los cuatro son OBLIGATORIOS y no tienen
// default. El `pointsToWin` sobre todo: el veredicto de la partida depende de él —entrar en
// PRESENTING_MATCH es alcanzarlo—, así que un valor inventado no reproduce el final. Con 0,
// además, `teamA >= 0` es verdadero desde el arranque y la partida cerraría en la primera
// comprobación. El `teamAssignment` tampoco es adorno: con `SHUFFLED` las parejas salen de
// sortear los asientos con el seed, así que asumir `SEAT_ORDER` reparte los puntos al equipo
// equivocado.
const matchId = process.argv[2];
const byArgs = process.argv.length > 3;
const seed = process.argv[3];
const pointsToWin = Number(process.argv[4]);
const teamAssignment = process.argv[5];
const seats = process.argv.slice(6);

function isTeamAssignment(value: string | undefined): value is TeamAssignmentMode {
  return value === "SHUFFLED" || value === "SEAT_ORDER";
}

function fail(message: string, detail: Record<string, unknown>): never {
  logger.error(message, detail);
  flushLogs();
  process.exit(1);
}

if (!matchId) fail(USAGE, { invalidos: ["matchId: falta"] });

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

if (entries.length === 0) fail("no hay historial para esa partida", { matchId });

async function fromRecord(id: string): Promise<Omit<ReplayInput, "entries">> {
  const record = await rootContainer.resolve<MatchArchive>("MatchArchive").recordOf(id);
  const recorded = record ? recordedReplayOf(record) : undefined;
  if (!recorded) {
    fail("la partida no tiene cabecera (registro anterior a la v2.1): pasá los argumentos", {
      matchId: id,
      uso: USAGE,
    });
  }
  return recorded;
}

function fromArgs(id: string): Omit<ReplayInput, "entries"> {
  // Se acumulan TODOS los argumentos inválidos y se listan juntos. Con el `if` booleano que
  // había, cinco argumentos mal daban el mismo USAGE genérico que uno solo, y el operador
  // —que llega acá con una partida que no puede rebobinar— los descubría de a uno por
  // corrida. No hay parser de argumentos de por medio a propósito: son cinco posiciones
  // fijas, y una dependencia para esto es más superficie de la que ahorra.
  const invalidos: string[] = [];
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
  if (seats.length < 2) {
    invalidos.push(`asientos: se esperaban al menos 2, llegaron ${seats.length}`);
  }
  // `fail` devuelve `never`, así que salir por acá ESTRECHA los tipos abajo — pero solo para las
  // condiciones escritas EN el `if`. `invalidos.length > 0` es opaco para tsc: no le dice nada
  // sobre `seed` ni sobre `teamAssignment`. Por eso las dos condiciones que estrechan se repiten:
  // no es defensa duplicada —son inalcanzables con el arreglo vacío—, es lo que permite que el
  // config de abajo se arme sin un solo cast.
  if (invalidos.length > 0 || !seed || !isTeamAssignment(teamAssignment)) {
    fail(USAGE, { invalidos });
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
  // siendo IDS DE ASIENTO —el vocabulario con el que el historial grabó la partida—, y un
  // documento de la forma vieja no guarda la cabecera de la mesa. `currency: "REPLAY"` es
  // una etiqueta que grita de dónde salió, y los montos van en cero con la tasa nula.
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
    matchId: id,
    gameModeId: "replay",
    seats: seats.map((userId, index) => ({
      userId,
      displayName: userId,
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
  return {
    meta: replayConfigOf(snapshot),
    // El MISMO `globalConfig` que el container del proceso derivó de `env`. Sin esto el
    // replay caía a `DEFAULT_GLOBAL_CONFIG` y le estampaba a una partida real plazos que
    // nunca tuvo —y un `extraTimeRemainingMs` inventado, que es estado observable del árbol
    // impreso—.
    //
    // ⚠ ES LA BASE, SIN LAS EDICIONES EN CALIENTE (`features/settings`): un documento de la forma
    // vieja no guarda con qué plazos nació su mesa. El desenlace sale igual —los vencimientos están
    // grabados como entradas del SISTEMA, no se recalculan—, pero los `activeDeadline` y el
    // `extraTimeRemainingMs` del árbol impreso son los de la base. Con cabecera, son los de la mesa.
    globalConfig: rootContainer.resolve<GlobalDominoConfig>("GlobalDominoConfig"),
    // Sin `startedAt`: un documento de la forma vieja no lo guarda —`begin()` no emite, así que la
    // primera entrada del historial ya es posterior—. El replay cae al `at` de la primera entrada,
    // así que `startedAt` sigue siendo lo único del árbol impreso que no es el de la partida real.
    // Con cabecera, sale de `matchStartedAt`.
  };
}

const setup = byArgs ? fromArgs(matchId) : await fromRecord(matchId);
logger.info("rebobinando", {
  matchId,
  entries: entries.length,
  desde: byArgs ? "argumentos" : "registro",
});
const state = replay({ ...setup, entries });
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
