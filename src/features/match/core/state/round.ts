import { type SchemaType, schema, t } from "@colyseus/schema";
import { BoardState } from "./board.js";
import { BoneyardState } from "./boneyard.js";

// UN EJE, UN CAMPO (spec §7.1): la fase reemplaza los booleanos del v1
// (isRoundFinished + bloqueo derivado + roundEndReason codificaban lo mismo tres veces).
//
// UNA FASE ES UN ESTADO QUE ESPERA ALGO —input, o el vencimiento de su plazo—.
//
// `DEALING` es la VENTANA DE REPARTO (reglas §3.1): al empezar la partida las fichas se
// reparten pero NO se hacen públicas, y cada jugador levanta las suyas con `REVEAL_TILES`
// dentro de 15 s. Mientras falte alguien la ronda no arranca; al vencer, el que no las
// levantó se retira. Es de la RONDA 1 nada más: de la 2 en adelante el reparto revela
// solo. Portado de truco (negocio v27 §12.7).
//
// Es la fase que hace que esperar sea observable, así que existe de verdad: repartir sí
// es síncrono, pero *esperar a que los dos estén ahí* no.
export type RoundPhase = "DEALING" | "PLAYING" | "PRESENTING_ROUND";
export type RoundEndReason = "DOMINO" | "BLOCKED";

// El turno: de quién es, y en qué tramo del plazo va. El instante de vencimiento vive
// UNIFICADO en `MatchState.activeDeadline` —no acá—, así que no hay `startedAt`: sería
// un segundo timestamp del mismo turno y nadie lo leería.
//
// `isConsumingExtendedTime` es el DISCRIMINADOR del front: los dos tramos (el normal y
// el de la reserva extra) ocurren con la misma `phase`, así que sin este campo el cliente
// ve una cuenta atrás y no sabe cuál de los dos está mirando.
//
// `consecutivePasses` es la ÚNICA huella que un pase deja en el estado: pasar no pone
// ficha en el tablero ni saca del pozo, así que sin este contador el rival no tiene de
// dónde enterarse (el historial de Mongo NO se sincroniza — spec §5.1).
export const Turn = schema(
  {
    playerId: t.string(),
    isConsumingExtendedTime: t.boolean().default(false),
    consecutivePasses: t.number().default(0),
  },
  "Turn",
);
export type Turn = SchemaType<typeof Turn>;

export const RoundSummary = schema(
  {
    roundNumber: t.number(),
    winnerId: t.string(),
    winnerTeamId: t.string(),
    points: t.number(),
    reason: t.string(),
  },
  "RoundSummary",
);
export type RoundSummary = SchemaType<typeof RoundSummary>;

// `starterId` es quién abrió ESTA ronda. No es adorno: la regla de secuencia
// (reglas §4.1) es que la ronda siguiente la abre el rival de quien abrió la anterior,
// así que sin este campo no hay de dónde sacar la alternancia una vez que el turno se
// movió. El v1 lo tenía (`currentRoundStarterId`); el doble-seis solo decide la RONDA 1.
//
// `boneyard` es una RAMA NULA (doctrina de truco, negocio §4.1: "ramas nulas para flujos
// condicionales; su ausencia codifica el caso"). AUSENTE = este modo no tiene pozo, que
// es exactamente 4P (4×7 = 28 = el set entero). Si estuviera siempre presente, un 4P
// arrancaría con `count: 0` y "modo sin pozo" sería indistinguible de "pozo agotado" —
// y esos dos casos son justo donde la tranca se calcula distinto (reglas §3.7).
// Lleva `.optional()`: sin él, `t.ref(BoneyardState)` auto-instancia el nodo en cuanto se
// construye `RoundState` (verificado contra `annotations.ts#makeAutoDefaultFactory` —
// cualquier ref a una Schema con constructor sin argumentos requeridos se auto-instancia
// por defecto), y la rama nula que describe este comentario sería, literalmente,
// imposible de representar.
//
// `currentTurn` también lleva `.optional()`, por la misma razón de auto-instanciación:
// arranca `undefined` y lo instancia la génesis (Tarea 6) al abrir la ronda.
export const RoundState = schema(
  {
    roundNumber: t.number(),
    phase: t.string().default("DEALING"),
    starterId: t.string(),
    board: t.ref(BoardState),
    boneyard: t.ref(BoneyardState).optional(),
    currentTurn: t.ref(Turn).optional(),
  },
  "RoundState",
);
export type RoundState = SchemaType<typeof RoundState>;
