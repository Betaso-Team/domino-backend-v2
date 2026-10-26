import { DEFAULT_GLOBAL_CONFIG, type GlobalDominoConfig } from "../core/config";
import type { StartingScore } from "../core/engine/genesis";
import type { MatchSetup, StoredMatchRecord } from "../network/history";
import { replayConfigOf } from "../transports/match-contract";
import type { ReplayInput } from "./replay";

// LA CABECERA DEL REGISTRO COMO ENTRADA DEL REPLAY. Desde la v2.1 el documento guarda lo que el replay
// necesita —el seed, las parejas, los plazos, el marcador inicial y las reglas de la mesa— y el CLI de
// soporte ya no tiene que pedírselo al operador, que era justo quien no lo sabía.
//
// Devuelve `undefined` para un documento sin cabecera —los de la forma vieja, o una partida que nunca
// abrió—: ahí el replay sigue necesitando los argumentos, y adivinarlos rebobinaría otra partida.
export function recordedReplayOf(
  record: StoredMatchRecord,
): Omit<ReplayInput, "entries"> | undefined {
  const setup = record as Partial<MatchSetup> & {
    readonly matchId?: string;
    readonly rateId?: string;
    readonly matchStartedAt?: Date;
    readonly rankingMultiplier?: { readonly base?: number };
  };
  const config = setup.matchConfig;
  if (!setup.matchId || !config?.seed || !setup.table || !setup.seats) return undefined;

  // `replayConfigOf` Y NO UN OBJETO A MANO, por lo mismo que en el CLI: el contrato es el único que
  // sabe armar un `DominoMatchConfig` válido. La tasa y la moneda no las consume el motor; la tasa
  // falta en una partida que no cerró, y va la nula que el CLI ya usaba.
  const meta = replayConfigOf({
    matchId: setup.matchId,
    gameModeId: setup.table.gameModeId,
    seats: setup.seats.map((seat) => ({
      userId: seat.userId,
      displayName: seat.displayName,
      ...(seat.username === undefined ? {} : { username: seat.username }),
      currency: seat.currency,
      playerId: seat.id,
    })),
    seed: config.seed,
    pointsToWin: config.pointsToWin,
    teamAssignment: config.teamAssignment,
    isDealWindowEnabled: config.isDealWindowEnabled,
    rateId: setup.rateId ?? "00000000-0000-4000-8000-000000000000",
    entryFee: setup.table.entryFeeInUC,
    prize: setup.table.prizeInUC,
    betLevels: config.betLevels,
    isFreeRoom: setup.table.isFree,
    enableBots: config.enableBots,
    multiplier: setup.rankingMultiplier?.base ?? 1,
    isRematchEnabled: config.isRematchEnabled,
  });

  // LOS PLAZOS CON QUE NACIÓ LA MESA, no los del entorno del que rebobina: los del entorno estampaban
  // `activeDeadline` y `extraTimeRemainingMs` que la partida nunca tuvo. Sobre el default, para que un
  // plazo que se agregue después a la config no deje al documento viejo sin el suyo.
  const { reconnectionWindowMs, ...inMs } = config.timeoutsInMs;
  const globalConfig: GlobalDominoConfig = {
    ...DEFAULT_GLOBAL_CONFIG,
    ...pick(inMs),
    tilesPerPlayer: config.tilesPerPlayer,
    ...(reconnectionWindowMs === undefined
      ? {}
      : { reconnectionWindowSeconds: reconnectionWindowMs / 1_000 }),
  };
  const startingScore: StartingScore = config.startingScore;

  return {
    meta,
    globalConfig,
    startingScore,
    ...(setup.matchStartedAt instanceof Date ? { startedAt: setup.matchStartedAt.getTime() } : {}),
  };
}

// Sólo las claves que la config global conoce: un plazo grabado que hoy no existe no se le cuela.
function pick(timeouts: Readonly<Record<string, number>>): Partial<GlobalDominoConfig> {
  const known = new Set(Object.keys(DEFAULT_GLOBAL_CONFIG));
  return Object.fromEntries(Object.entries(timeouts).filter(([key]) => known.has(key)));
}
