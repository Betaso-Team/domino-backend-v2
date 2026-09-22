import type { DeadlineKind } from "../events";
import type { MatchState } from "../state";
import { InvariantViolationError } from "./errors";
import { matchPhaseOf, roundPhaseOf } from "./state-projections";

// A qué VENTANA sirve el plazo vigente. Un solo campo en el estado ⇒ un solo evento
// de vencimiento y un solo eje que lo discrimine. La usan los conductores para
// despachar al vencer Y el registro para explicar el hueco donde el reloj decidió,
// así que la rama tomada y lo que queda escrito no pueden discrepar.
//
// `TURN` cubre los DOS tramos del turno —el plazo normal y el consumo de la reserva—
// porque los dos ocurren en `phase === "PLAYING"`. Eso es correcto acá: para el
// despacho da igual cuál de los dos venció, la rama es la misma. Quién los distingue
// es `Turn.isConsumingExtendedTime`, y existe para el FRONT (que si no muestra una
// cuenta atrás sin saber de qué) y para que el conductor sepa que ya no hay más colchón.
// Las tres de la REVANCHA van PRIMERO, y no es orden arbitrario: son fases de PARTIDA y en
// todas ellas `currentRound` ya no existe, así que caer más abajo daría la invariante del final
// —«sin ventana temporizada»— en vez de la ventana que sí hay.
export function deadlineKindOf(match: MatchState): DeadlineKind {
  const phase = matchPhaseOf(match);
  if (phase === "REMATCH_WINDOW") return "REMATCH_WINDOW";
  if (phase === "REMATCH_NEGOTIATION") return "REMATCH_NEGOTIATION";
  if (phase === "REMATCH_ACCEPTED") return "REMATCH_ACCEPTED";
  if (phase === "PRESENTING_MATCH") return "PRESENTING_MATCH";
  if (match.currentRound && roundPhaseOf(match.currentRound) === "PRESENTING_ROUND") {
    return "PRESENTING_ROUND";
  }
  // La ventana de reparto tiene plazo PROPIO, distinto del turno: cuando vence no se
  // retira a uno, se retira a todos los que no levantaron sus fichas (reglas §3.1).
  if (match.currentRound && roundPhaseOf(match.currentRound) === "DEALING") return "DEALING";
  // El aumento va ANTES que el turno: mientras se negocia, el plazo vigente es el de la
  // respuesta, aunque el turno siga asignado al mismo de antes —se congeló, no se movió—.
  if (match.currentRound && roundPhaseOf(match.currentRound) === "NEGOTIATING_BET") {
    return "NEGOTIATING_BET";
  }
  if (match.currentRound && roundPhaseOf(match.currentRound) === "PLAYING") return "TURN";
  // Dos causas MUY distintas caen en esta misma línea, y el mensaje no las separa:
  // (a) `match.phase` genuinamente no tiene ventana propia (p. ej. "NOT_STARTED"), o
  // (b) `match.phase === "PLAYING"` pero `match.currentRound` es `undefined` — la ronda
  // nunca se creó. El (b) es un bug de otro conductor (el de RONDA, que arranca en la
  // Tarea 8+), no de éste; si lo ves, no busques una fase sin ventana, buscá por qué no
  // hay ronda.
  throw new InvariantViolationError(`sin ventana temporizada en fase ${match.phase}`);
}
