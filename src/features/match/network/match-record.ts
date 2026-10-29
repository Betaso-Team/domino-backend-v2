import type { DominoMatchConfig, GlobalDominoConfig } from "../core/config";
import { betAmountsOf } from "../core/rules/config";
import type { MatchState } from "../core/state";
import type { NetworkMatchEvent } from "./events";
import type { MatchClose, MatchHistory, MatchSetup, SeatMoney } from "./history";
import type { MatchEventSink } from "./listeners";
import type { MatchAbortReason } from "./match-results";
import { payoutOf } from "./payout";

// LAS DOS PUNTAS DEL REGISTRO QUE NO SON DEL GRABADOR: con qué se armó la mesa —que la sala sabe al
// nacer— y cómo terminó —que se cuenta con la plata, y la plata es de la sala y del orquestador—.
// Puras, salvo el sink del final, que sólo decide CUÁNDO.

/**
 * EL ARMADO, copiado al registro cuando la partida abre. Se lee del snapshot y del árbol YA SEMBRADO:
 * el equipo de cada asiento sale del seed en la génesis, y el marcador inicial es el que la génesis
 * puso (cero salvo el `starting-score` de local y dev).
 *
 * @param table lo que la sala sabe y el snapshot no: su `roomId` y el nombre del modo tal como el
 * catálogo lo tenía al sentarla.
 */
export function matchSetupOf(
  config: DominoMatchConfig,
  globalConfig: GlobalDominoConfig,
  match: MatchState,
  table: { readonly roomId: string; readonly gameModeName: string },
): MatchSetup {
  const teamOf = new Map(match.players.map((player) => [player.playerId, player.teamId]));
  return {
    roomId: table.roomId,
    table: {
      gameModeId: config.gameModeId,
      name: table.gameModeName,
      entryFeeInUC: config.entryFee,
      prizeInUC: config.prize,
      isFree: config.isFreeRoom,
    },
    matchConfig: {
      playersQuantity: config.seats.length,
      pointsToWin: config.pointsToWin,
      startingScore: { teamA: match.scoreboard?.teamA ?? 0, teamB: match.scoreboard?.teamB ?? 0 },
      timeoutsInMs: timeoutsOf(globalConfig),
      seed: config.seed,
      teamAssignment: config.teamAssignment,
      isDealWindowEnabled: config.isDealWindowEnabled,
      tilesPerPlayer: globalConfig.tilesPerPlayer,
      betLevels: config.betLevels.map(({ level, extra, additionalPoints }) => ({
        level,
        extra,
        additionalPoints,
      })),
      enableBots: config.enableBots,
      isRematchEnabled: config.isRematchEnabled,
    },
    seats: config.seats.map((seat, index) => ({
      id: seat.playerId,
      // `as` sobre un valor que la génesis escribió desde `assignTeams`, que sólo devuelve A o B.
      teamId: (teamOf.get(seat.playerId) ?? "A") as "A" | "B",
      seat: index,
      userId: seat.userId,
      displayName: seat.displayName,
      ...(seat.username === undefined ? {} : { username: seat.username }),
      currency: seat.currency,
    })),
  };
}

// TODOS LOS PLAZOS EN MS, por nombre. La reconexión es el único en segundos —es la unidad de
// `allowReconnection`— y se guarda convertida, con su nombre en ms, para que el mapa diga una sola
// unidad. El replay la vuelve a segundos (`history/recorded.ts`).
function timeoutsOf(globalConfig: GlobalDominoConfig): Record<string, number> {
  const inMs = Object.entries(globalConfig).filter(
    ([key, value]) => key.endsWith("Ms") && typeof value === "number",
  );
  return {
    ...Object.fromEntries(inMs),
    reconnectionWindowMs: globalConfig.reconnectionWindowSeconds * 1_000,
  };
}

/** Lo que la SALA sabe del cierre y el evento no. */
export interface EndingFacts {
  /** ¿El orquestador confirmó el cobro de la entrada? Sin eso nadie pagó nada. */
  readonly entryCharged: boolean;
  /** El motivo que sólo la sala sabe (`CHARGE_REJECTED`). Le gana al del evento, como en el resultado. */
  readonly abortReason?: MatchAbortReason;
}

/**
 * EL DESENLACE COMO LO CUENTA EL REGISTRO, o `undefined` si el evento no es un desenlace. La plata sale
 * de las MISMAS fuentes que el resultado que recibe el orquestador: el premio de `payoutOf` y el
 * aumento del ESTADO, así que lo que el registro dice que se pidió pagar es lo que se publicó.
 */
export function matchCloseOf(
  event: NetworkMatchEvent,
  match: MatchState,
  config: DominoMatchConfig,
  facts: EndingFacts,
): MatchClose | undefined {
  if (event.type !== "MATCH_RESOLVED" && event.type !== "MATCH_ABORTED") return undefined;
  const level = match.acceptedBetLevel;
  const extra = level > 0 ? betAmountsOf(level, config.entryFee, config.prize) : undefined;
  const entryFee = config.entryFee + (extra?.additionalEntryFee ?? 0);
  const prizes = new Map<string, number>();
  if (event.type === "MATCH_RESOLVED") {
    for (const { userId, amount } of payoutOf(event, match, config)?.entries ?? [])
      prizes.set(userId, amount);
  }
  const money: Record<string, SeatMoney> = Object.fromEntries(
    config.seats.map((seat) => [
      seat.playerId,
      {
        chargedInUC: facts.entryCharged ? entryFee : 0,
        prizePaidInUC: prizes.get(seat.userId) ?? 0,
      },
    ]),
  );
  const common = {
    rateId: config.rateId,
    money,
    betMultiplier: {
      offeredValues: config.betLevels.map((option) => option.level),
      finalValue: level > 0 ? level : 1,
      ...(extra
        ? {
            resultingEntryFeeInUC: entryFee,
            resultingPrizeInUC: config.prize + extra.additionalPrize,
          }
        : {}),
    },
    rankingMultiplier: {
      base: config.multiplier,
      extra: match.acceptedBetExtra,
      final: config.multiplier + match.acceptedBetExtra,
    },
  };
  if (event.type === "MATCH_ABORTED") {
    return {
      status: "aborted",
      matchEndReason: facts.abortReason ?? event.reason,
      winnerIds: [],
      ...common,
    };
  }
  return {
    status: "finished",
    matchEndReason: event.reason,
    winnerTeamId: event.winnerTeamId,
    winnerIds: match.players
      .filter((player) => player.teamId === event.winnerTeamId)
      .map((player) => player.playerId),
    ...common,
  };
}

/**
 * EL QUE CIERRA EL REGISTRO, enganchado como sink de la sala DESPUÉS del historial —así el cierre llega
 * a la base detrás de la entrada que lo cuenta—.
 *
 * Una partida TERMINADA espera al cobro del aumento en vuelo antes de cerrar, por lo mismo que el
 * resultado (`MatchResultRecorder`): con el cobro todavía viajando el estado dice x2, y el registro
 * diría cobrado un aumento que el orquestador puede rechazar. El apagado no necesita esperar esto
 * aparte: `shutdown()` drena primero los resultados —que esperan a ESTE MISMO cobro— y recién después
 * el historial, así que para entonces el cierre ya llegó al puerto.
 *
 * Una ABORTADA cierra en el acto: no lleva premio, y el apagado no la esperaría.
 */
export function recordEndingSink(
  history: Pick<MatchHistory, "close">,
  config: DominoMatchConfig,
  match: MatchState,
  facts: {
    readonly entryCharged: () => boolean;
    readonly abortReason: () => MatchAbortReason | undefined;
    readonly settledBet?: () => Promise<void>;
  },
): MatchEventSink {
  const endingOf = (event: NetworkMatchEvent) =>
    matchCloseOf(event, match, config, {
      entryCharged: facts.entryCharged(),
      abortReason: facts.abortReason(),
    });
  return (events) => {
    for (const event of events) {
      // SE PROYECTA YA, aunque haya que esperar: una invariante rota (`payoutOf`) lanza adentro del
      // comando que cerró la mesa, como en el resultado, y no como una promesa rechazada que nadie mira.
      const ending = endingOf(event);
      if (!ending) continue;
      if (event.type === "MATCH_ABORTED" || !facts.settledBet) {
        history.close(ending);
        continue;
      }
      const afterCharge = () => {
        // Releído con el cobro ya resuelto: si no salió, el trato ya está anulado en el estado.
        let settled = ending;
        try {
          settled = endingOf(event) ?? ending;
        } catch {
          // La primera proyección ya pasó las mismas guardas: si ésta lanza, se cierra con aquélla.
        }
        history.close(settled);
      };
      // Con las dos ramas: un cobro que rechazara dejaría el registro sin cerrar, y una promesa
      // rechazada sin oyente tumba el proceso con todas las demás partidas adentro.
      void facts.settledBet().then(afterCharge, afterCharge);
    }
  };
}
