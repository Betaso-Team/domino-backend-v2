import { type SchemaType, schema, t } from "@colyseus/schema";
import { Tile } from "./tile";

// NODO MIXTO, y es la pieza que cierra el agujero de trampa del v1 (spec §7.1):
// `tileCount` es público —el front tiene que saber cuántas fichas le quedan al rival—
// y `tiles` es de VISTA, así que solo llega al dueño del asiento.
//
// `isRevealed` es la decisión CON MEMORIA del cierre de ronda: la mano se hace pública a
// TODOS para contar los pips, y eso vive en el estado para que el árbol sea autocontenido
// para el front y para el replay.
//
// ⚠ NO CONFUNDIR con `PlayerState.hasSeenTiles`. Son dos ejes distintos y el v1 los
// habría metido en un booleano:
//   · `hasSeenTiles`  → el DUEÑO levantó sus fichas. Audiencia: él. Pasa una vez por
//                       partida, en la ventana de reparto.
//   · `Hand.isRevealed` → la mano es pública para TODOS. Pasa al cerrar cada ronda.
// Que el dueño las haya visto no las hace públicas, y hacerlas públicas al final no dice
// nada sobre si las levantó al principio.
export const Hand = schema(
  {
    tileCount: t.number().default(0),
    isRevealed: t.boolean().default(false),
    tiles: t.array(Tile).view(),
  },
  "Hand",
);
export type Hand = SchemaType<typeof Hand>;

// `extraTimeRemainingMs` es la RESERVA de tiempo extra para TODA la partida, y solo
// decrece (modelo de truco, `PlayerState.extraTimeRemainingMs`). Es un cambio DELIBERADO
// respecto del v1, que reseteaba los 30 s de gracia en cada turno: acá el que la gasta se
// queda sin colchón. Va en el jugador y no en config porque es un saldo con memoria —lo
// único que el motor le resta— y va acá y no en `Turn` porque cruza los turnos y las rondas.
//
// NO lleva `score`. El marcador vive SOLO en `MatchState.scoreboard`: el puntaje de un
// jugador es `scoreboard[teamOf(player)]`, incluso en 4P, donde la regla del v1 le da a
// los dos compañeros el total idéntico (por eso el v1 leía un "capitán"). Tenerlo en los
// dos lados era doble contabilidad del mismo dinero, con un solo escritor que actualizaba
// ambos —justo la desincronización que spec §7.1 quiere evitar—. Truco tampoco lo tiene.
//
// `hasSeenTiles`: ¿ya levantó sus fichas? Se marca UNA vez por partida, con el verbo
// `REVEAL_TILES`, y NO se resetea entre rondas —la ventana de reparto es solo la de la
// ronda 1—. Es **público** a propósito: el front tiene que poder decir *a quién se está
// esperando*, que es la mitad del valor de la ventana.
// EL ESTADO ES LO QUE SE JUEGA Y SE DIBUJA, y todo lo que está acá viaja al wire. Los datos de
// infraestructura —la moneda con que se cobró la inscripción, la tasa— no son del juego: viven en
// el `seat` de la config congelada (`config.seats`), que es de donde los lee la liquidación.
// `displayName`/`username`/`profilePicture` son lo que el front dibuja.
//
// EL ESTADO ES DE TODA LA MESA, y en una mesa cruzada la mesa tiene jugadores de dos proveedores: lo que
// se sincroniza acá lo ve el jugador de cada uno. Por eso los campos que viajan son una lista cerrada
// —la fija `state.test.ts`— y ninguno es privado de un asiento: ni su `userId`, ni su proveedor, ni su
// moneda, ni su precio. El cliente encuentra SU asiento por el `seat.playerId` de su mensaje `config`.
export const PlayerState = schema(
  {
    playerId: t.string(),
    displayName: t.string(),
    username: t.string().optional(),
    profilePicture: t.string().optional(),
    teamId: t.string(),
    seatIndex: t.number(),
    connected: t.boolean().default(true),
    hasAbandoned: t.boolean().default(false),
    hasSeenTiles: t.boolean().default(false),
    extraTimeRemainingMs: t.number().default(0),
    hand: t.ref(Hand),
    // ⚠ VA AL FINAL, y no es orden alfabético: `@colyseus/schema` codifica por ÍNDICE, así que
    // insertarlo entre `teamId` y `hand` corre todos los campos posteriores y un cliente con el
    // schema pre-generado decodifica basura. Es la ruptura de wire que la identidad
    // multiplataforma ya pagó una vez.
    //
    // ESTE ASIENTO LO JUEGA LA MÁQUINA. Nace del que se retiró de una mesa de cuatro: el bot no
    // se sienta de cero, HEREDA el asiento —su mano, su equipo, su lugar en la rueda— para que
    // el compañero que no hizo nada no quede jugando uno contra dos. Es la regla de v1, que lo
    // marca sobre el MISMO jugador (`bot.id = player.id`, `on-leave.ts:114-115`) en vez de
    // sentar a uno nuevo.
    //
    // Es PÚBLICO porque el front lo pinta, y es lo que separa a este campo de `hasAbandoned`:
    // los dos dicen "acá no hay nadie" pero uno deja la mesa andando y el otro la cierra. Y
    // separa además quién COBRA — el bot no, ver `network/payout.ts`.
    isBot: t.boolean().default(false),
    // EL `sub` DEL TOKEN DE ESTE ASIENTO, y NO VIAJA (`noSync()`: no ocupa índice ni entra en
    // `toJSON()`). Viajó un tiempo para que el cliente reconociera su asiento, y así el jugador de un
    // proveedor veía el `userId` del rival de otro; hoy el asiento propio llega en el mensaje `config`
    // (`seat.playerId`). Era el último campo sincronizado, así que dejar de sincronizarlo no corre ningún
    // índice.
    //
    // SIGUE EN EL ÁRBOL, del lado del servidor, porque es la identidad con la que el cierre comprueba
    // que el estado y el snapshot son de la misma mesa antes de pagar (`assertSameTable`, en
    // `network/payout.ts`): dos mesas de dos tienen los mismos `seat-N`, y sin esto un cruce le pagaría
    // el premio a otra persona sin hacer ruido.
    userId: t.string().noSync(),
    // CÓMO SE FUE DEL ASIENTO: `voluntary` (el verbo `ABANDON`), `timeout` (lo retiró el reloj, en la
    // ventana de reparto o en su turno, con el socket conectado) o `disconnected` (lo retiró el reloj
    // con el socket caído, `connected === false`: el mismo criterio que separa `TIMEOUT` de
    // `DISCONNECTED` en el registro, `network/history.ts`). Vacío mientras sigue jugando. Lo escribe el mismo que escribe
    // `hasAbandoned` e `isBot` (`MatchPlayer`), y lo lee el resultado que se publica (un torneo trata
    // distinto al que se rinde y al que desaparece).
    //
    // `noSync()`: NO VIAJA AL WIRE ni entra en `toJSON()` —no ocupa índice, así que no corre ningún
    // campo del cliente— porque al front no le hace falta y a los goldens no les cambia nada.
    leftBy: t.string().noSync().default(""),
    // CUÁNDO SE FUE (epoch ms, la hora del conductor); `0` mientras sigue jugando. Lo escribe el mismo
    // que escribe `leftBy`, y lo lee el resultado para los segundos jugados de cada participante.
    // `noSync()`, por la misma razón que `leftBy`.
    leftAt: t.number().noSync().default(0),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;

/** Cómo dejó el asiento quien lo dejó (`PlayerState.leftBy`). */
export type SeatExitKind = "voluntary" | "timeout" | "disconnected";
