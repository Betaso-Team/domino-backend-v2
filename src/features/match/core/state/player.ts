import { type SchemaType, schema, t } from "@colyseus/schema";
import { Tile } from "./tile.js";

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
export const PlayerState = schema(
  {
    playerId: t.string(),
    teamId: t.string(),
    seatIndex: t.number(),
    connected: t.boolean().default(true),
    hasAbandoned: t.boolean().default(false),
    hasSeenTiles: t.boolean().default(false),
    extraTimeRemainingMs: t.number().default(0),
    hand: t.ref(Hand),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;
