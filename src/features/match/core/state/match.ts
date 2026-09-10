import { type SchemaType, schema, t } from "@colyseus/schema";
import { PlayerState } from "./player.js";
import { RoundState, RoundSummary } from "./round.js";

// DOS PALABRAS, DOS HECHOS (truco negocio v26, changelog "Revancha" §3). `RESOLVED` es el
// VEREDICTO —el juego dictaminó— y por eso vive SOLO en eventos (`ROUND_RESOLVED`,
// `MATCH_RESOLVED`); `FINISHED` es el terminal de ESTA MÁQUINA —no queda nada por hacer en
// esta mesa— y por eso vive SOLO en fases. Coinciden mientras la partida se apaga al
// dictaminarse; la REVANCHA los separa, y ahí el nombre repetido pasa a mentir. Truco lo
// pagó y lo renombró: acá se nace con la separación hecha.
//
// `FINISHED` es el ÚNICO terminal, y NO hay un `ABORTED` que lo acompañe: una partida que
// muere sin veredicto no es una transición del juego, es la sala que se muere. Eso lo
// cuenta `MATCH_ABORTED`, que es evento de PLATAFORMA (network/events.ts).
//
// Las dos fases de la REVANCHA (`REMATCH_WINDOW`, `REMATCH_NEGOTIATION`) van DESPUÉS del
// veredicto y ANTES del terminal. NO entran en esta rebanada, pero el enum está ordenado
// para recibirlas sin renombrar nada: es la razón entera de haber separado las palabras.
export type MatchPhase = "NOT_STARTED" | "PLAYING" | "PRESENTING_MATCH" | "FINISHED";

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
    phase: t.string().default("NOT_STARTED"),
    scoreboard: t.ref(Scoreboard).optional(),
    players: t.array(PlayerState),
    currentRound: t.ref(RoundState).optional(),
    pastRounds: t.array(RoundSummary),
    pointsToWin: t.number().default(0),
    activeDeadline: t.number().default(0),
    startedAt: t.number().default(0),
  },
  "MatchState",
);
export type MatchState = SchemaType<typeof MatchState>;
