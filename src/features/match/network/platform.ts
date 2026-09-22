import {
  type AccountDirectory,
  DuplicateMovementError,
  InsufficientFundsError,
  type Ledger,
  type MatchAccounts,
  type Outbox,
  type PlayerAccount,
  type WalletPort,
} from "@/features/economy";
import {
  type ParticipationReporter,
  type StrikeBook,
  type TournamentClient,
  type TournamentConfig,
  TournamentUnavailableError,
  computeQuality,
} from "@/features/tournament";
import type { Logger } from "@/shared/logger";
import type { MatchState } from "../core/state";
import type { DominoRoomOptions } from "../transports/match-contract";
import type { MatchEventSink } from "./listeners";
import type { MatchSummaryPort } from "./player-log";

export class AdmissionRefusedError extends Error {
  constructor(
    readonly reason: "INSUFFICIENT_FUNDS" | "NOT_ENROLLED" | "TOURNAMENT_UNAVAILABLE",
    readonly playerId: string,
  ) {
    super(`admisión rechazada (${reason}): ${playerId}`);
    this.name = "AdmissionRefusedError";
  }
}

export interface MatchPlatformDeps {
  readonly wallet: WalletPort;
  readonly ledger: Ledger;
  readonly accounts: AccountDirectory;
  readonly matchAccounts: MatchAccounts;
  readonly outbox?: Outbox;
  readonly tournament?: TournamentClient;
  readonly participation?: ParticipationReporter;
  readonly strikes: StrikeBook;
  readonly tournamentConfig: TournamentConfig;
  readonly summaries: MatchSummaryPort;
  readonly now: () => number;
  readonly log: Logger;
}

/** Platform seam shared by casual and tournament matches; the engine remains synchronous. */
export class MatchPlatform {
  private readonly summarized = new Set<string>();
  constructor(private readonly deps: MatchPlatformDeps) {}

  async admit(
    options: DominoRoomOptions,
    matchId: string,
    playerId: string,
    token: string,
  ): Promise<PlayerAccount | undefined> {
    if (options.mode === "TOURNAMENT") {
      const tournament = this.deps.tournament;
      if (!tournament) throw new AdmissionRefusedError("TOURNAMENT_UNAVAILABLE", playerId);
      try {
        if ((await tournament.infoOf(options.tournamentId)).status !== "IN_GAME")
          throw new AdmissionRefusedError("TOURNAMENT_UNAVAILABLE", playerId);
        if (!(await tournament.isEnrolled(options.tournamentId, token)))
          throw new AdmissionRefusedError("NOT_ENROLLED", playerId);
      } catch (error) {
        if (error instanceof AdmissionRefusedError) throw error;
        if (error instanceof TournamentUnavailableError)
          throw new AdmissionRefusedError("TOURNAMENT_UNAVAILABLE", playerId);
        throw error;
      }
      return this.profileOf(playerId, token);
    }

    let account: PlayerAccount | undefined;
    if (options.entryFee > 0 || options.prize > 0)
      account = await this.deps.matchAccounts.accountOf(matchId, playerId, token);
    if (options.entryFee > 0) await this.charge(matchId, playerId, options.entryFee);
    return account ?? this.profileOf(playerId, token);
  }

  sinkFor(
    options: DominoRoomOptions,
    matchId: string,
    match: MatchState,
    send: (playerId: string, type: string, payload: unknown) => void,
  ): MatchEventSink {
    return (events) => {
      for (const event of events) {
        if (event.type === "MATCH_RESOLVED" || event.type === "MATCH_ABORTED")
          this.summarize(options, matchId, match, event);
        if (options.mode === "CASUAL") {
          if (event.type === "MATCH_ABORTED") {
            void this.deps.wallet
              .refundMatch(matchId, options.seats)
              .catch((err) => this.deps.log.error("falló el reembolso de sala", { err, matchId }));
          }
          if (event.type === "MATCH_RESOLVED") {
            for (const player of match.players) {
              if (player.teamId !== event.winnerTeamId) continue;
              this.deps.outbox?.enqueue(
                { matchId, playerId: player.playerId, amount: options.prize, reason: "PRIZE" },
                "CREDIT",
              );
            }
          }
          continue;
        }

        if (event.type === "ABANDON") {
          void this.deps.strikes
            .add(options.tournamentId, event.playerId)
            .then((penalty) =>
              send(event.playerId, "TOURNAMENT_PENALTY", {
                strikes: penalty.strikes,
                penalizedUntil:
                  penalty.blockedUntil > 0 ? new Date(penalty.blockedUntil).toISOString() : null,
              }),
            )
            .catch((err) =>
              this.deps.log.error("no se pudo anotar el strike", {
                err,
                playerId: event.playerId,
              }),
            );
        }
        if (event.type === "MATCH_RESOLVED")
          this.reportTournament(options, matchId, match, event.winnerTeamId, send);
      }
    };
  }

  private async charge(matchId: string, playerId: string, amount: number): Promise<void> {
    const movement = { matchId, playerId, amount, reason: "ENTRY_FEE" as const };
    if (await this.deps.ledger.has(matchId, playerId, movement.reason)) return;
    try {
      await this.deps.ledger.reserve(movement);
    } catch (error) {
      if (error instanceof DuplicateMovementError) return;
      throw error;
    }
    try {
      await this.deps.wallet.charge(movement);
      await this.deps.ledger.settle(movement);
    } catch (error) {
      await this.deps.ledger.fail(movement);
      if (error instanceof InsufficientFundsError)
        throw new AdmissionRefusedError("INSUFFICIENT_FUNDS", playerId);
      throw error;
    }
  }

  private async profileOf(playerId: string, token: string): Promise<PlayerAccount | undefined> {
    try {
      return await this.deps.accounts.accountOf(playerId, token);
    } catch {
      return undefined;
    }
  }

  private reportTournament(
    options: Extract<DominoRoomOptions, { mode: "TOURNAMENT" }>,
    matchId: string,
    match: MatchState,
    winnerTeamId: string,
    send: (playerId: string, type: string, payload: unknown) => void,
  ): void {
    const reporter = this.deps.participation;
    if (!reporter) return;
    const roundsPlayed = match.pastRounds.length;
    const durationMs = Math.max(0, this.deps.now() - match.startedAt);
    const quality = computeQuality(roundsPlayed, durationMs, this.deps.tournamentConfig);
    for (const player of match.players) {
      const won = player.teamId === winnerTeamId;
      const score = won ? quality.grade : options.pointsPerLoss;
      if (
        reporter.report({
          tournamentId: options.tournamentId,
          matchId,
          playerId: player.playerId,
          username: player.username ?? "",
          profilePicture: player.profilePicture ?? "",
          score,
          matchScore:
            player.teamId === "A" ? (match.scoreboard?.teamA ?? 0) : (match.scoreboard?.teamB ?? 0),
          wins: won ? 1 : 0,
          losses: won ? 0 : 1,
          gamesPlayed: 1,
          roundsPlayed,
          durationMs,
          qualityRatio: quality.ratio,
          grade: quality.grade,
        })
      )
        send(player.playerId, "MATCH_POINTS", {
          score,
          reduced: won && score < (this.deps.tournamentConfig.qualityScale[0]?.points ?? 0),
        });
    }
  }

  private summarize(
    options: DominoRoomOptions,
    matchId: string,
    match: MatchState,
    event: { type: "MATCH_RESOLVED"; winnerTeamId: string } | { type: "MATCH_ABORTED" },
  ): void {
    if (this.summarized.has(matchId)) return;
    this.summarized.add(matchId);
    const scoreOf = (teamId: string) =>
      teamId === "A" ? (match.scoreboard?.teamA ?? 0) : (match.scoreboard?.teamB ?? 0);
    const playerOf = (player: MatchState["players"][number]) => ({
      id: player.playerId,
      score: scoreOf(player.teamId),
      currency: player.currency,
    });
    this.deps.summaries.summarize({
      matchId,
      status: event.type === "MATCH_RESOLVED" ? "finished" : "canceled",
      winnerIds:
        event.type === "MATCH_RESOLVED"
          ? match.players
              .filter(({ teamId }) => teamId === event.winnerTeamId)
              .map(({ playerId }) => playerId)
          : [],
      entryFee: options.mode === "CASUAL" ? options.entryFee : 0,
      prize: options.mode === "CASUAL" ? options.prize : 0,
      isFreeRoom: options.mode === "CASUAL" ? options.isFreeRoom : false,
      gameModeId: options.mode === "CASUAL" ? options.gameModeId : options.tournamentId,
      players: match.players.filter(({ hasAbandoned }) => !hasAbandoned).map(playerOf),
      quitPlayers: match.players.filter(({ hasAbandoned }) => hasAbandoned).map(playerOf),
      playedAt: new Date(this.deps.now()),
    });
  }
}
