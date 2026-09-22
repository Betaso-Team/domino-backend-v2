import { z } from "zod";
import type { GlobalDominoConfig } from "./core/config";

// LA CONFIG GLOBAL DEL DOMINÓ, EDITABLE EN CALIENTE: qué campos y entre qué cotas. Vive en la raíz de
// la feature y no en `core/` porque zod es un paquete de runtime (Regla 2). Portado de truco
// (`3cab0f8`), con los campos y las cotas del dominó.
const SECOND = 1_000;

// LAS COTAS NO SON GUSTO, son lo que impide que una edición rompa el juego de una de tres maneras:
//
//   · el CERO, o cualquier cosa ya vencida, re-arma un plazo vencido en el mismo instante en que se
//     estampa: la fase se despierta, se encuentra a sí misma y lo vuelve a estampar, para siempre;
//   · el reloj de la sala NO satura, así que un valor enorme simplemente nunca dispara y la mesa se
//     congela viva, sin que nadie pueda jugar;
//   · un valor por debajo de lo que cuesta un viaje de ida y vuelta retira al que iba a contestar a
//     tiempo.
//
// Donde v1 tiene cota, la cota es la de v1 (`TIMEOUT_LIMITS` en
// `Betaso-Domino-Backend/src/shared/types/game-settings.type.ts`): el turno de 15 a 300 s y la reserva
// de 10 a 120 s. v1 las declaraba y nunca las aplicaba —ningún camino escribía sus plazos—, así que
// acá son la primera vez que valen.
const ms = (min: number, max: number) => z.number().int().min(min).max(max);

// Una pausa sólo se MIRA, así que equivocarse cuesta paciencia de un lado y una mesa congelada del
// otro.
const pause = () => ms(200, 30 * SECOND);

const FIELDS = {
  turnTimeoutMs: ms(15 * SECOND, 300 * SECOND),
  extraTimeReserveMs: ms(10 * SECOND, 120 * SECOND),
  // Mira a TODOS a la vez: demasiado corta y la ronda retira a la mesa entera con la inscripción ya
  // cobrada.
  dealingTimeoutMs: ms(5 * SECOND, 120 * SECOND),
  presentingRoundMs: pause(),
  presentingMatchMs: pause(),
  // Demasiado corto y la sala se cierra antes de que un cliente ya emparejado consuma su reserva.
  seatingTimeoutMs: ms(10 * SECOND, 120 * SECOND),
  // En SEGUNDOS, como `allowReconnection`. Menos de diez es un corte de wifi que ya retira.
  reconnectionWindowSeconds: z.number().int().min(10).max(600),
  // Por debajo de un viaje de ida y vuelta, todo aumento se contesta solo con un no.
  betResponseTimeoutMs: ms(5 * SECOND, 60 * SECOND),
  // El cero es legítimo: un bot que juega en el acto. La sala lo acota además a medio turno.
  botTurnDelayMs: ms(0, 10 * SECOND),
  rematchWindowMs: ms(5 * SECOND, 120 * SECOND),
  rematchResponseMs: ms(2 * SECOND, 60 * SECOND),
  // Lo que la sala VIEJA se sostiene para que el cliente alcance a entrar a la nueva: por debajo de
  // tres segundos el que aceptó se queda sin la partida que aceptó.
  rematchHandoffMs: ms(3 * SECOND, 30 * SECOND),
} as const;

// LOS CAMPOS QUE NO SE EDITAN EN CALIENTE, y por qué.
//
// `tilesPerPlayer` es REGLA DE JUEGO y no un plazo: con cuatro jugadores las 28 fichas se reparten
// enteras y no hay pozo, así que otro número rompe el reparto o el pozo de toda mesa que nazca.
export const MATCH_NOT_EDITABLE = ["tilesPerPlayer"] as const;

// Un parche sobre la config global: PARCIAL para que un campo viaje solo, ESTRICTO para que un typo
// se rechace.
export const matchConfigPatch = z.strictObject(FIELDS).partial() satisfies z.ZodType<
  Partial<GlobalDominoConfig>
>;

export const MATCH_EDITABLE: readonly string[] = Object.keys(FIELDS);
