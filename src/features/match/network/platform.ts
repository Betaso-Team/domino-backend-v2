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
} from "@/features/tournament";
import type { Logger } from "@/shared/logger";
import type { MatchState } from "../core/state";
import type { DominoRoomOptions } from "../transports/match-contract";
import { payWinner } from "./casual/pay-winner";
import { refundOnAbort } from "./casual/refund-on-abort";
import type { MatchEventSink, MatchMessenger } from "./listeners";
import type { MatchSummaryPort } from "./player-log";
import { recordSummary } from "./summary";
import { addStrike } from "./tournament/add-strike";
import { reportParticipation } from "./tournament/report-participation";

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

/**
 * LA COSTURA CON LA PLATAFORMA, compartida por casual y torneo. Hace DOS cosas y son de dos momentos:
 *
 *   · `admit` decide ANTES —cobra la inscripción, comprueba la inscripción al torneo— y PUEDE
 *     rechazar;
 *   · `sinkFor` reacciona DESPUÉS, y no decide nada propio: COMPONE un sink por hecho —pagar,
 *     reembolsar, escribir la fila, anotar el strike, reportar al torneo— para la mesa que se lo pide.
 *     Cada uno vive en su archivo (`casual/`, `tournament/`, `summary.ts`), que es donde se lee y se
 *     testea su regla. Portado de la partición de truco (`betaso/casual`, `betaso/tournament`).
 *
 * El motor sigue síncrono: todo lo que sale de acá arranca trabajo y no lo espera.
 */
export class MatchPlatform {
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

  /** UNO POR MESA: lo que cada sink recuerda entre lotes vive en su cierre. */
  sinkFor(
    options: DominoRoomOptions,
    matchId: string,
    match: MatchState,
    send: MatchMessenger,
  ): MatchEventSink {
    const { deps } = this;
    const sinks: MatchEventSink[] = [
      recordSummary({ options, matchId, match, summaries: deps.summaries, now: deps.now }),
    ];
    if (options.mode === "CASUAL") {
      sinks.push(
        refundOnAbort({ matchId, match, wallet: deps.wallet, log: deps.log }),
        payWinner({ matchId, match, table: options, outbox: deps.outbox }),
      );
    } else {
      sinks.push(
        addStrike({
          tournamentId: options.tournamentId,
          match,
          strikes: deps.strikes,
          send,
          log: deps.log,
        }),
      );
      if (deps.participation)
        sinks.push(
          reportParticipation({
            options,
            matchId,
            match,
            reporter: deps.participation,
            config: deps.tournamentConfig,
            send,
            now: deps.now,
          }),
        );
    }
    return (events) => {
      for (const sink of sinks) sink(events);
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
}
