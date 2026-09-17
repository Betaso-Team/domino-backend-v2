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
// `NEGOTIATING_BET` es la ventana de respuesta del AUMENTO DE APUESTA (en v1,
// `PROPOSE_BET_MULTIPLIER` y sus 10 s). Es una fase y no un booleano por la misma razón que
// las otras tres: es un estado que ESPERA algo —la respuesta del rival, o el vencimiento de
// su plazo— y el modelo tiene UN SOLO `activeDeadline`. Sin fase propia, el plazo de la
// negociación y el del turno serían el mismo campo queriendo decir dos cosas.
//
// CONGELA EL TURNO SIN TOCARLO: `currentTurn` queda intacto, así que al volver a `PLAYING`
// sigue siendo de quien era. Lo único que cambia es quién puede actuar, y eso ya lo dice la
// fase. El plazo del turno se re-estampa entero al volver, que es lo que evita que negociar
// le coma el reloj al que no propuso.
export type RoundPhase = "DEALING" | "PLAYING" | "NEGOTIATING_BET" | "PRESENTING_ROUND";
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

// LA NEGOCIACIÓN EN CURSO del aumento de apuesta, y SOLO mientras está en curso: es una
// RAMA NULA (ausente = nadie propuso nada en esta ronda). Lo acordado no vive acá sino en
// `MatchState.betMultiplier`, que es un escalar de la PARTIDA con elemento neutro — la misma
// partición que ya existe entre una ronda que se reemplaza entera y un marcador que
// sobrevive. Así no hay estado de "propuesta vieja ya resuelta" que limpiar ni que
// interpretar.
//
// NO lleva `respondentId`: en una mesa de dos, el que responde es el que no propuso, y
// guardarlo sería un campo derivado (doctrina del repo). Tampoco lleva el instante de
// vencimiento, que vive unificado en `MatchState.activeDeadline` como el de toda otra fase.
//
// SÍ lleva lo que el rival necesita para DECIDIR, porque es lo único que no puede derivar:
// cuánto se suma al multiplicador (`extra`, que es lo que termina en los puntos de ranking)
// y cuánto le sale a cada uno aceptar (`additionalEntryFee`). Un "sí" a ciegas sobre dinero
// real no es un sí.
export const BetOffer = schema(
  {
    proposerId: t.string(),
    level: t.number(),
    extra: t.number(),
    additionalEntryFee: t.number(),
    // EL RELOJ DEL TURNO, CONGELADO. Único campo de acá que no es para el front: mientras se
    // negocia, `activeDeadline` lo ocupan los 10 s de la respuesta, así que lo que le quedaba
    // al que estaba jugando no tiene dónde esperar.
    //
    // Sin esto, volver de la negociación re-estampaba el turno ENTERO — y eso es un turno
    // gratis para el que propone: proponés, te rechazan, y volvés con el reloj a cero. Es
    // acotado (una vez por ronda, y solo con el tablero casi vacío) pero es una ventaja real
    // en una mesa con plata, así que se devuelve exactamente lo que había.
    turnRemainingMs: t.number().default(0),
  },
  "BetOffer",
);
export type BetOffer = SchemaType<typeof BetOffer>;

export const RoundSummary = schema(
  {
    roundNumber: t.number(),
    winnerId: t.string(),
    winnerTeamId: t.string(),
    points: t.number(),
    reason: t.string(), // RoundEndReason — misma nota que `side` en tile.ts
  },
  "RoundSummary",
);
export type RoundSummary = SchemaType<typeof RoundSummary>;

// `starterId` es quién abrió ESTA ronda. No es adorno: la regla de secuencia
// (reglas §4.1) es que la ronda siguiente la abre el rival de quien abrió la anterior,
// así que sin este campo no hay de dónde sacar la alternancia una vez que el turno se
// movió. El v1 lo tenía (`currentRoundStarterId`); el doble-seis solo decide la RONDA 1.
//
// `roundNumber` y `starterId` quedan tipados como `t.string()`/`t.number()` sin
// `.optional()` ni `.default()`: son campos de IDENTIDAD, no de estado. No tienen un
// valor de reposo con sentido (¿`roundNumber: 0`? ¿`starterId: ""`?), así que en vez de
// inventarles uno se dejan sin default y la génesis (Tarea 6) los asigna ATÓMICAMENTE al
// construir la ronda, en el mismo paso en que decide `starterId`. Antes de eso, en un
// `RoundState` recién creado, valen `undefined` en tiempo de ejecución pese al tipo
// declarado — que es exactamente lo que un `new RoundState()` sin `.optional()` produce
// en @colyseus/schema 5.0.27 para un campo `t.string()`/`t.number()` que nunca fue
// asignado. Los campos de ESTADO (`phase`, `isConsumingExtendedTime`,
// `consecutivePasses`, etc.) sí llevan `.default()`, porque para ellos "recién creado"
// SÍ es un valor legítimo.
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
    phase: t.string().default("DEALING"), // RoundPhase — misma nota que `side` en tile.ts
    starterId: t.string(),
    board: t.ref(BoardState),
    boneyard: t.ref(BoneyardState).optional(),
    currentTurn: t.ref(Turn).optional(),
    // `.optional()` por lo mismo que `boneyard` y `currentTurn`: sin él,
    // `t.ref(BetOffer)` auto-instancia el nodo al construir `RoundState` y la rama nula
    // —ausente = nadie propuso— sería imposible de representar.
    betOffer: t.ref(BetOffer).optional(),
  },
  "RoundState",
);
export type RoundState = SchemaType<typeof RoundState>;
