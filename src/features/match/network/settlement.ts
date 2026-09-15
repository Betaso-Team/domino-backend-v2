import type { PlayerRef } from "../../../shared/player-ref.js";
import type { DominoMatchConfig, MatchSeat } from "../core/config.js";
import { InvariantViolationError } from "../core/engine/errors.js";
import type { MatchState } from "../core/state/index.js";
import type { NetworkMatchEvent } from "./events.js";

// LA PROYECCIÓN, NO EL MOVIMIENTO. Acá se traduce el desenlace de una mesa a lo que
// HABRÍA que pagar, y nada más: no hay puerto de wallet, ni adaptador remoto, ni outbox,
// porque todavía no existe un orquestador a quien entregarle el trabajo. Es una función
// PURA —el mismo evento sobre la misma mesa da siempre la misma instrucción—, y por eso
// se puede volver a llamar sin consecuencias mientras el que cobra no exista.
//
// Vive en `network/` y no en `core/` porque `MATCH_ABORTED` es un evento de PLATAFORMA:
// el dominio no tiene un final sin veredicto, así que el core no podría nombrarlo.
export type SettlementKind = "REWARD" | "REFUND";

/**
 * A quién se le acredita y cuánto. Lleva la pareja `{ platformId, userUuid }` —y no el
 * `playerId` opaco— porque el asiento es interno de la partida: quien cobre tiene que
 * resolver una billetera, y `seat-1` no nombra a nadie afuera de esta mesa.
 *
 * `currency` es la moneda CONGELADA de la inscripción y el monto viene en UC menores tal
 * cual se cobró: acá no se convierte nada. La conversión es del `rateId` de la
 * instrucción, y es de quien pague.
 *
 * `idempotencyKey` se SERIALIZA con `JSON.stringify` en vez de concatenarse, por el mismo
 * motivo que el índice del registro: `["m","a:b"]` y `["m:a","b"]` no pueden colisionar, y
 * una colisión acá es un pago que no se hace porque otro ya usó la clave.
 */
export interface SettlementEntry extends PlayerRef {
  readonly currency: string;
  readonly amountUcMinor: number;
  readonly idempotencyKey: string;
}

export interface SettlementInstruction {
  readonly matchId: string;
  readonly rateId: string;
  readonly kind: SettlementKind;
  readonly entries: readonly SettlementEntry[];
}

const entryOf = (
  config: DominoMatchConfig,
  kind: SettlementKind,
  amountUcMinor: number,
  seat: MatchSeat,
): SettlementEntry => ({
  platformId: seat.platformId,
  userUuid: seat.userUuid,
  currency: seat.currency,
  amountUcMinor,
  idempotencyKey: JSON.stringify([config.matchId, kind, seat.platformId, seat.userUuid]),
});

/**
 * El desenlace de la mesa como instrucción monetaria, o `undefined` si el evento no es un
 * desenlace. La mayoría de los eventos no lo son —una desconexión no es plata— y devolver
 * `undefined` es lo que deja al que llame filtrar sin conocer el catálogo entero.
 *
 * Los tres motivos de `MATCH_ABORTED` reembolsan igual (`network/events.ts`): la
 * diferencia entre ellos es para soporte, no para la caja.
 */
export function settlementOf(
  event: NetworkMatchEvent,
  match: MatchState,
  config: DominoMatchConfig,
): SettlementInstruction | undefined {
  if (event.type === "MATCH_ABORTED") {
    return {
      matchId: config.matchId,
      rateId: config.rateId,
      kind: "REFUND",
      entries: config.seats.map((seat) => entryOf(config, "REFUND", config.entryFeeUcMinor, seat)),
    };
  }
  if (event.type !== "MATCH_RESOLVED") return undefined;

  // El equipo ganador se lee del ESTADO —que es quien reparte los asientos en equipos— y
  // la identidad se lee de la CONFIG, que es donde está congelada. Cruzarlos por el id
  // opaco es lo que mantiene al motor sin saber de plataformas.
  const winnerIds = new Set(
    match.players
      .filter(({ teamId }) => teamId === event.winnerTeamId)
      .map(({ playerId }) => playerId),
  );
  const winners = config.seats.filter(({ playerId }) => winnerIds.has(playerId));
  // PLATA DE POR MEDIO: ante la duda, rechazar. Cero ganadores sería un veredicto sobre un
  // equipo que no existe, y varios —el 4P, que este contrato todavía no sabe liquidar—
  // dejaría el premio de la mesa sin una regla escrita de cómo se parte. Las dos cosas son
  // un invariante roto, y un invariante roto cierra la partida en vez de pagar de más.
  if (winners.length !== 1) {
    throw new InvariantViolationError(
      `la liquidación 2P necesita exactamente un ganador, recibió ${winners.length}`,
    );
  }
  return {
    matchId: config.matchId,
    rateId: config.rateId,
    kind: "REWARD",
    entries: winners.map((seat) => entryOf(config, "REWARD", config.prizeUcMinor, seat)),
  };
}
