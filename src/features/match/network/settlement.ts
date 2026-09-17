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
 * ⚠ `currency` ES LA MONEDA EN QUE SE COBRÓ, NO LA UNIDAD DEL MONTO, y confundirlas es la
 * ambigüedad más cara que puede tener este tipo. `amount` está SIEMPRE en UC COMPLETAS —la
 * unidad interna, la misma que guarda el catálogo—, así que
 * `{ currency: "VES", amount: 250 }` **no** son 250 bolívares: son 250 UC que este jugador
 * pagó en VES y que en VES tiene que cobrar. Lo que traduce una cosa en la otra es el
 * `rateId` de la instrucción, y la traducción es del que PAGA: acá no se convierte nada,
 * porque convertir dos veces con dos tasas da dos pagos distintos —y el redondeo a los
 * centavos de esa moneda también es del que paga, por lo mismo—.
 *
 * `idempotencyKey` se SERIALIZA con `JSON.stringify` en vez de concatenarse, por el mismo
 * motivo que el índice del registro: `["m","a:b"]` y `["m:a","b"]` no pueden colisionar, y
 * una colisión acá es un pago que no se hace porque otro ya usó la clave.
 */
export interface SettlementEntry extends PlayerRef {
  readonly currency: string;
  readonly amount: number;
  readonly idempotencyKey: string;
}

export interface SettlementInstruction {
  readonly matchId: string;
  readonly rateId: string;
  readonly kind: SettlementKind;
  readonly entries: readonly SettlementEntry[];
}

// Recibe el `matchId` pelado y no la `config` entera A PROPÓSITO: con la config adentro
// podría leerse `prize` o `entryFee` desde acá, y entonces el monto de una entrada dejaría
// de estar decidido en un solo lugar. El que llama elige cuánto; éste solo sabe armar la
// entrada.
const entryOf = (
  matchId: string,
  kind: SettlementKind,
  amount: number,
  seat: MatchSeat,
): SettlementEntry => ({
  platformId: seat.platformId,
  userUuid: seat.userUuid,
  currency: seat.currency,
  amount,
  idempotencyKey: JSON.stringify([matchId, kind, seat.platformId, seat.userUuid]),
});

/**
 * ¿Este estado y este snapshot son de la MISMA mesa? Es la pregunta que el desajuste de
 * argumentos no contesta solo, y por eso se pregunta explícitamente antes de tocar plata.
 *
 * Los `playerId` son opacos **y posicionales** (`seat-1`, `seat-2`, …), así que existen
 * idénticos en TODAS las mesas. Cruzar el estado de una con el snapshot de otra no da cero
 * ganadores ni dos —que serían ruidosos—: da EXACTAMENTE UNO, y emite una instrucción
 * internamente coherente, con el `matchId` y el `rateId` correctos, que le paga el premio a
 * otra persona. El fallo más caro de este archivo es el que no hace ruido.
 *
 * POR ESO NO ALCANZA CON COMPARAR LA FORMA. Dos mesas 2P tienen los mismos `seat-N`, así
 * que el largo y la pertenencia coinciden y el cruce pasaría. Lo que las distingue es la
 * IDENTIDAD que cada asiento lleva: `PlayerState` guarda la pareja congelada
 * (`core/state/player.ts`), escrita una sola vez desde el asiento en `genesis.ts` y sin
 * ninguna otra ruta de escritura en el repo. Comparar la pareja asiento por asiento vuelve
 * la guarda exacta hoy, sin tocar el schema y sin costo de wire: esos campos son `noSync()`
 * y no salen al cliente.
 */
const assertSameTable = (match: MatchState, config: DominoMatchConfig): void => {
  const seatsById = new Map(config.seats.map((seat) => [seat.playerId, seat]));
  // Nombra el DESAJUSTE y no el conteo de ganadores: «recibió 0 ganadores» manda a soporte
  // a investigar el veredicto de una partida que se jugó bien, cuando lo que está mal es
  // quién llamó con qué.
  const reject = (detail: string): never => {
    throw new InvariantViolationError(
      `el estado y el snapshot no son de la misma mesa ${config.matchId}: ${detail}`,
    );
  };

  if (match.players.length !== config.seats.length) {
    reject(`${match.players.length} jugadores contra ${config.seats.length} asientos`);
  }
  for (const player of match.players) {
    const seat = seatsById.get(player.playerId);
    if (!seat) reject(`${player.playerId} no tiene asiento`);
    else if (seat.platformId !== player.platformId || seat.userUuid !== player.userUuid) {
      reject(
        `${player.playerId} es ${JSON.stringify([player.platformId, player.userUuid])} en el estado y ${JSON.stringify([seat.platformId, seat.userUuid])} en el snapshot`,
      );
    }
  }
};

function rewardOf(
  winnerTeamId: string,
  match: MatchState,
  config: DominoMatchConfig,
): SettlementInstruction {
  // El equipo ganador se lee del ESTADO —que es quien reparte los asientos en equipos— y
  // la identidad se lee de la CONFIG, que es donde está congelada. Cruzarlos por el id
  // opaco es lo que mantiene al motor sin saber de plataformas.
  const winnerIds = new Set(
    match.players.filter(({ teamId }) => teamId === winnerTeamId).map(({ playerId }) => playerId),
  );
  const winners = config.seats.filter(({ playerId }) => winnerIds.has(playerId));
  // PLATA DE POR MEDIO: ante la duda, rechazar. Cero ganadores sería un veredicto sobre un
  // equipo que no existe, y varios —el 4P, que `configOf` ya acepta— dejaría el premio de la
  // mesa sin una regla escrita de cómo se parte. Las dos cosas son un invariante roto, y un
  // invariante roto cierra la partida en vez de pagar de más.
  if (winners.length !== 1) {
    throw new InvariantViolationError(
      `la liquidación 2P necesita exactamente un ganador, recibió ${winners.length}`,
    );
  }
  return {
    matchId: config.matchId,
    rateId: config.rateId,
    kind: "REWARD",
    entries: winners.map((seat) => entryOf(config.matchId, "REWARD", config.prize, seat)),
  };
}

/**
 * El desenlace de la mesa como instrucción monetaria, o `undefined` si el evento no es un
 * desenlace. La mayoría de los eventos no lo son —una desconexión no es plata— y devolver
 * `undefined` es lo que deja al que llame filtrar sin conocer el catálogo entero.
 *
 * EL `switch` ES EXHAUSTIVO A PROPÓSITO, con los no-terminales enumerados uno por uno y un
 * `never` en el default. Un `if (type !== "MATCH_RESOLVED") return undefined` alcanzaría
 * hoy y fallaría en silencio mañana: el día que `PlatformMatchEvent` sume un cuarto miembro
 * que TAMBIÉN devuelva plata —una cancelación, una expulsión por fraude— compilaría sin una
 * línea roja, esto devolvería `undefined`, nadie cobraría y nadie se enteraría. Con el
 * `never`, el gate `typecheck` obliga a decidir si el evento nuevo mueve dinero.
 *
 * Los tres motivos de `MATCH_ABORTED` reembolsan IGUAL (`network/events.ts`): la diferencia
 * entre ellos es para soporte, no para la caja. Los tres están medidos en la suite.
 *
 * Un monto de cero —mesa gratis, `entryFee: 0`— EMITE la instrucción igual, con sus
 * entradas en cero. Suprimirla ahorraría un mensaje y costaría dos cosas: el rastro de que
 * esa mesa se liquidó, y la distinción entre "no hubo desenlace" y "el desenlace no movía
 * plata", que pasarían a ser el mismo `undefined`. Filtrar montos nulos es del que paga.
 */
export function settlementOf(
  event: NetworkMatchEvent,
  match: MatchState,
  config: DominoMatchConfig,
): SettlementInstruction | undefined {
  switch (event.type) {
    case "MATCH_ABORTED": {
      assertSameTable(match, config);
      return {
        matchId: config.matchId,
        rateId: config.rateId,
        kind: "REFUND",
        entries: config.seats.map((seat) =>
          entryOf(config.matchId, "REFUND", config.entryFee, seat),
        ),
      };
    }
    case "MATCH_RESOLVED": {
      assertSameTable(match, config);
      return rewardOf(event.winnerTeamId, match, config);
    }
    // Los que NO son un desenlace, enumerados para que agregar uno obligue a pasar por acá.
    case "ROUND_RESOLVED":
    case "DEADLINE_EXPIRED":
    case "ABANDON":
    // NO paga ni cobra: es un aumento que NO prosperó, así que la mesa vale lo mismo que
    // antes. El que sí va a mover dinero es el aumento ACEPTADO, y todavía no existe como
    // desenlace acá — se asienta en `MatchState.acceptedBetExtra` y lo cobra el adaptador
    // que falta (ver `BetChargePort`). Cuando llegue, entra por este mismo `switch`.
    case "BET_MULTIPLIER_REJECTED":
    case "PLAYER_DISCONNECTED":
    case "PLAYER_RECONNECTED":
      return undefined;
    // El `never` chequea en COMPILACIÓN; el `throw` chequea en EJECUCIÓN, y hacen falta los
    // dos. `return unhandled` devolvería el evento mismo tipado como instrucción: un objeto
    // sin `entries`, sin `kind` y sin `matchId` llegándole al que paga. La unión es una
    // promesa del tipo, no del dato — los eventos que la Task 3 arma vienen del historial en
    // Mongo—, así que acá se rechaza en vez de dejar pasar algo con forma de pago.
    default: {
      const unhandled: never = event;
      throw new InvariantViolationError(
        `evento de plataforma desconocido: ${JSON.stringify(unhandled)}`,
      );
    }
  }
}
