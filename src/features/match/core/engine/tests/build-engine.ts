import {
  AbandonCommand,
  DrawTileCommand,
  PassCommand,
  PlayTileCommand,
  ProposeBetMultiplierCommand,
  RespondBetMultiplierCommand,
  RevealTilesCommand,
} from "../../commands";
import type { BetLevel, DominoMatchConfig, GlobalDominoConfig } from "../../config";
import { DEFAULT_GLOBAL_CONFIG, playerIdsOf } from "../../config";
import type { MatchEvent } from "../../events";
import type { MatchState } from "../../state";
import { Tile } from "../../state";
import type { BoardSide } from "../../state/tile";
import { BetNegotiation, BetReferee } from "../bet";
import type { Clock } from "../clock";
import { Dealer } from "../dealer";
import { createMatchState } from "../genesis";
import { MatchDriver } from "../match/driver";
import { MatchPlayer } from "../match/player";
import { MatchReferee } from "../match/referee";
import { MoveLog } from "../move-log";
import { Player } from "../player-facade";
import { PlayerRepository } from "../player-repository";
import { Referee } from "../referee-facade";
import { RematchGate } from "../rematch/gate";
import { RematchNegotiation } from "../rematch/negotiation";
import { RoundDriver } from "../round/driver";
import { RoundPlayer } from "../round/player";
import { RoundReferee } from "../round/referee";
import { Scorer } from "../scorer";
import { boneyardOf, currentRoundOf, handOf } from "../state-projections";
import type { TimeoutScheduler } from "../timeout-scheduler";
import type { SchemaVisibilityController } from "../visibility";
import { matchConfig } from "./match-config-fixture";

class FixedDealer extends Dealer {
  constructor(
    private readonly fixtureMatch: MatchState,
    private readonly fixtureConfig: DominoMatchConfig,
    private readonly fixtureGlobalConfig: GlobalDominoConfig,
    private readonly deck: readonly { left: number; right: number }[],
  ) {
    super(fixtureMatch, fixtureConfig, fixtureGlobalConfig);
  }

  override deal(_roundNumber: number): void {
    let cursor = 0;
    for (const playerId of playerIdsOf(this.fixtureConfig)) {
      const hand = handOf(playerId, this.fixtureMatch);
      hand.tiles.clear();
      for (let dealt = 0; dealt < this.fixtureGlobalConfig.tilesPerPlayer; dealt += 1) {
        const tile = this.deck[cursor];
        cursor += 1;
        if (!tile) break;
        hand.tiles.push(this.tile(tile));
      }
      hand.tileCount = hand.tiles.length;
      hand.isRevealed = false;
    }

    const round = currentRoundOf(this.fixtureMatch);
    if (round.boneyard) {
      const boneyard = boneyardOf(round);
      boneyard.tiles.clear();
      for (const tile of this.deck.slice(cursor)) boneyard.tiles.push(this.tile(tile));
      boneyard.count = boneyard.tiles.length;
    }
  }

  private tile({ left, right }: { left: number; right: number }): Tile {
    const tile = new Tile();
    tile.left = left;
    tile.right = right;
    return tile;
  }
}

interface EngineOptions {
  readonly extraTimeReserveMs?: number;
  readonly isDealWindowEnabled?: boolean;
  readonly betLevels?: readonly BetLevel[];
  readonly isRematchEnabled?: boolean;
  readonly enableBots?: boolean;
}

export function engineWithHands(
  handsBySeat: Record<string, [number, number][]>,
  boneyard: [number, number][] = [],
  options: EngineOptions = {},
) {
  const seats = Object.keys(handsBySeat);
  const lengths = new Set(Object.values(handsBySeat).map((tiles) => tiles.length));
  if (lengths.size !== 1) throw new Error("todas las manos tienen que tener el mismo largo");
  const tilesPerPlayer = [...lengths][0] as number;
  const deck = [
    ...seats.flatMap((seat) => (handsBySeat[seat] ?? []).map(([left, right]) => ({ left, right }))),
    ...boneyard.map(([left, right]) => ({ left, right })),
  ];

  const globalConfig: GlobalDominoConfig = {
    ...DEFAULT_GLOBAL_CONFIG,
    tilesPerPlayer,
    turnTimeoutMs: 600,
    extraTimeReserveMs: options.extraTimeReserveMs ?? 0,
    presentingRoundMs: 120,
    presentingMatchMs: 120,
    // Los tres de la revancha, encogidos como los demás: lo que la suite mide es la
    // transición, no cuánto dura.
    rematchWindowMs: 300,
    rematchResponseMs: 50,
    rematchHandoffMs: 60,
  };
  const config: DominoMatchConfig = matchConfig(seats, {
    isDealWindowEnabled: options.isDealWindowEnabled ?? false,
    // Vacío salvo que la suite lo pida: una mesa sin catálogo no ofrece aumentar, que es el
    // reposo de producción.
    betLevels: options.betLevels ?? [],
    isRematchEnabled: options.isRematchEnabled ?? false,
    enableBots: options.enableBots ?? false,
  });
  const match = createMatchState(config);
  const clockBox = { now: 1_000 };
  const clock: Clock = { now: () => clockBox.now };
  const scheduled: number[] = [];
  let pending: (() => readonly MatchEvent[]) | undefined;
  const scheduler: TimeoutScheduler = {
    schedule(at, onExpire) {
      scheduled.push(at);
      pending = onExpire;
    },
    cancel() {
      pending = undefined;
    },
  };
  const visibility: SchemaVisibilityController = { makePublic() {}, hide() {} };

  const matchReferee = new MatchReferee(match);
  const roundReferee = new RoundReferee(match);
  const scorer = new Scorer(match);
  const dealer = new FixedDealer(match, config, globalConfig, deck);
  const repository = new PlayerRepository(
    seats,
    (playerId) => new MatchPlayer(playerId, match),
    (playerId) => new RoundPlayer(playerId, match, visibility),
  );
  const players = new Player(repository);
  const referee = new Referee(matchReferee, roundReferee);
  const bet = new BetNegotiation(match);
  const moves = new MoveLog(match);
  const roundDriver = new RoundDriver(
    match,
    clock,
    globalConfig,
    config,
    roundReferee,
    dealer,
    scorer,
    (playerId) => repository.round(playerId),
    bet,
  );
  const gate = new RematchGate(config.isRematchEnabled);
  const rematch = new RematchNegotiation(match);
  const matchDriver = new MatchDriver(
    match,
    clock,
    scheduler,
    globalConfig,
    matchReferee,
    players,
    roundDriver,
    gate,
    rematch,
    config,
  );
  const commands = {
    ABANDON: new AbandonCommand(referee, matchDriver),
    PLAY_TILE: new PlayTileCommand(referee, players, matchDriver, moves),
    DRAW_TILE: new DrawTileCommand(referee, players, matchDriver, moves),
    PASS: new PassCommand(referee, matchDriver, moves),
    REVEAL_TILES: new RevealTilesCommand(referee, players, matchDriver),
    PROPOSE_BET_MULTIPLIER: new ProposeBetMultiplierCommand(
      new BetReferee(match, config),
      bet,
      roundDriver,
    ),
    RESPOND_BET_MULTIPLIER: new RespondBetMultiplierCommand(
      new BetReferee(match, config),
      bet,
      roundDriver,
      match,
    ),
  };

  return {
    match,
    players,
    referee,
    matchDriver,
    gate,
    clockBox,
    scheduled,
    start: () => matchDriver.begin(),
    round: () => currentRoundOf(match),
    hand: (playerId: string) => handOf(playerId, match),
    playTile: (playerId: string, tile: { left: number; right: number }, side: BoardSide) =>
      commands.PLAY_TILE.execute({ playerId, ...tile, side }),
    drawTile: (playerId: string) => commands.DRAW_TILE.execute({ playerId }),
    pass: (playerId: string) => commands.PASS.execute({ playerId }),
    revealTiles: (playerId: string) => commands.REVEAL_TILES.execute({ playerId }),
    abandon: (playerId: string) => commands.ABANDON.execute({ playerId }),
    proposeBet: (playerId: string, level: number) =>
      commands.PROPOSE_BET_MULTIPLIER.execute({ playerId, level }),
    respondBet: (playerId: string, accept: boolean) =>
      commands.RESPOND_BET_MULTIPLIER.execute({ playerId, accept }),
    // La compensación del cobro, que en producción pide la RED por `EngineGraph`.
    revokeMultiplier: () => bet.revoke(),
    fireTimeout(): readonly MatchEvent[] {
      if (!pending) throw new Error("no hay timeout programado");
      const run = pending;
      pending = undefined;
      return run();
    },
  };
}
