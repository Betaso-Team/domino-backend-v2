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
// EL CORTE ENTRE PRESENTACIÓN E IDENTIDAD, y es el motivo por el que los seis campos de
// abajo no son un solo bloque. `displayName`/`username`/`profilePicture` son lo que el
// front dibuja y viajan al wire; el `userId` de plataforma y la moneda ya
// cobrada son `noSync()` —viven en la instancia del servidor y NO entran a la metadata,
// así que no se codifican, no se sincronizan y ni siquiera aparecen en `toJSON()`—.
//
// Están en el árbol igual, y no en un mapa aparte de la sala, porque son del ASIENTO:
// quien tenga el `PlayerState` tiene todo lo que hace falta para liquidarlo, sin un
// segundo lugar obligado a mantenerse en sincronía con éste.
export const PlayerState = schema(
  {
    playerId: t.string(),
    displayName: t.string(),
    username: t.string().optional(),
    profilePicture: t.string().optional(),
    userId: t.string().noSync(),
    currency: t.string().noSync(),
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
    // separa además quién COBRA — el bot no, ver `network/settlement.ts`.
    isBot: t.boolean().default(false),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;
