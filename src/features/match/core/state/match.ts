import { type SchemaType, schema, t } from "@colyseus/schema";
import { PlayerState } from "./player.js";
import { RoundState, RoundSummary } from "./round.js";

// La unión se declara en `rules/phases.js` —es vocabulario del juego, no del wire— y se
// re-exporta acá, que es de donde la importaba todo el mundo.
export type { MatchPhase } from "../rules/phases.js";

export const Scoreboard = schema(
  { teamA: t.number().default(0), teamB: t.number().default(0) },
  "Scoreboard",
);
export type Scoreboard = SchemaType<typeof Scoreboard>;

// Raíz persistente de la partida. `currentRound` se REEMPLAZA entera cada ronda;
// de las pasadas solo sobrevive el resumen. El detalle completo vive en el
// historial de Mongo (spec §5).
// El `seed` NO está acá — vive en DominoMatchConfig, inyectado (spec §7.1).
//
// `activeDeadline` es UN SOLO campo: un solo plazo temporizado a la vez. Es un instante
// ABSOLUTO en **epoch ms del servidor**, no un resto que baje. Dos consecuencias:
//   · El servidor no lo re-emite nunca: se estampa una vez por transición. Ahí muere el
//     patch por segundo del v1.
//   · El front tiene que restarle "ahora", y su propio reloj puede estar corrido. Por eso
//     `GET /config/:roomId` devuelve `serverNow`: con eso calcula el offset una vez.
// Es epoch y no la timeline de la sala a propósito — ver spec §7.4.
//
// `scoreboard` y `currentRound` llevan `.optional()`. Verificado contra el código fuente
// instalado (`annotations.ts#makeAutoDefaultFactory`): un `t.ref(X)` SIN `.optional()`
// auto-instancia `X` en cuanto su constructor no exige argumentos —que es el caso de
// `Scoreboard` y `RoundState`—, así que sin este modificador `scoreboard` y `currentRound`
// existirían desde el primer `new MatchState()` y nunca podrían representar "todavía no
// hay marcador" / "todavía no hay ronda". `.optional()` es lo que los deja arrancar
// `undefined`; la génesis (Tarea 6) los instancia.
export const MatchState = schema(
  {
    phase: t.string().default("NOT_STARTED"), // MatchPhase — misma nota que `side` en tile.ts
    scoreboard: t.ref(Scoreboard).optional(),
    players: t.array(PlayerState),
    currentRound: t.ref(RoundState).optional(),
    pastRounds: t.array(RoundSummary),
    pointsToWin: t.number().default(0),
    activeDeadline: t.number().default(0),
    startedAt: t.number().default(0),
    // LO ACORDADO en el aumento de apuesta, y por eso es de la PARTIDA y no de la ronda: se
    // negocia una vez y vale hasta el final, mientras que la oferta que lo produjo muere con
    // su ronda (`RoundState.betOffer`). Es la misma partición que hay entre `currentRound`,
    // que se reemplaza entera, y `scoreboard`, que sobrevive.
    //
    // SUMAN, NO MULTIPLICAN, y el neutro es 0: el v1 liquida con
    // `multiplier + acceptedBetExtra`, donde el primero es el del modo y vive en la config.
    // Truco usa un escalar multiplicativo con neutro 1; copiar esa forma acá habría cambiado
    // lo que se paga.
    //
    // `acceptedBetLevel` en 0 es "ninguno aceptado", y es lo que responde la regla de v1 de
    // UN SOLO aumento aceptado por partida. Se guarda además del extra porque es lo que viaja
    // en la traza del ranking, y dos niveles distintos podrían dar el mismo extra.
    //
    // EL MOTOR NO CALCULA CON ESTOS DOS NÚMEROS: son económicos. Las piedras se cuentan igual
    // con aumento que sin él — quien los lee es la liquidación, al cerrar.
    acceptedBetExtra: t.number().default(0),
    acceptedBetLevel: t.number().default(0),
  },
  "MatchState",
);
export type MatchState = SchemaType<typeof MatchState>;
