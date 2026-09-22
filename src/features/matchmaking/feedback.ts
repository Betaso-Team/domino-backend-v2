import type { Logger } from "@/shared/logger";
import type { CooldownBook } from "./core/cooldown";
import { CASUAL_SCOPE, type VetoBook } from "./veto";

// HOW MATCHMAKING FINDS OUT that a match closed.
//
// The problem it solves is one of DIRECTION: matchmaking depends on `match` and not the other way
// round, so a match's scope cannot import this feature to say "veto these two" or "give them the
// cooldown". Nor the reverse: the books are matchmaking state and have no business living inside a
// room that dies with the match.
//
// The seam is the match notifier's **sink**, which is TOTAL — it sees the platform events too — and
// is supplied by the composition root, the one place in the repo that can know both features. Nothing
// is decided here: already-decided facts are heard and written down.
//
// The events come in untyped on purpose: importing their type would be importing `match`, which is
// exactly what this file exists to avoid. What is needed is read.
interface AnyEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface MatchmakingFeedbackDeps {
  readonly cooldown: CooldownBook;
  readonly veto: VetoBook;
  // The casual veto's switch. The tournament one does not consult it: that one cannot be turned off.
  readonly isCasualVetoEnabled: () => Promise<boolean>;
  readonly log: Logger;
}

/**
 * Which match this is. Supplied by whoever builds the sink, because the closing
 * events do not say: the verdict is a TRUCO fact and has no business knowing
 * which table the match came out of.
 */
export interface MatchOrigin {
  // The pool they came out of: the table in casual, the tournament in a tournament.
  readonly poolId: string;
  readonly playerIds: readonly string[];
}

// BOTH endings. The cooldown is handed out alike in either: all it does is keep them from returning
// to the queue at the same instant, which holds whether the match ended well or fell over.
const CLOSED = new Set(["MATCH_RESOLVED", "MATCH_ABORTED"]);

export function matchmakingSink(deps: MatchmakingFeedbackDeps, match: MatchOrigin) {
  return (events: readonly AnyEvent[]): void => {
    for (const event of events) {
      if (CLOSED.has(event.type)) {
        // The books live in Redis, so writing is asynchronous and this sink is not — the notifier
        // that calls it is synchronous by contract. It is released with its own `.catch()`: in Node
        // an unhandled rejection terminates the process, and this runs when EVERY match closes.
        void deps.cooldown
          .assign(match.poolId, match.playerIds)
          .catch((e) =>
            deps.log.error("no se pudo repartir el cooldown", { err: e, poolId: match.poolId }),
          );
        continue;
      }
      // The TOURNAMENT veto arrives already decided by the scope and carries its own tournament: a
      // match belongs to exactly one, but the event says so and there is no reason to guess.
      if (event.type === "PAIR_VETOED") {
        void deps.veto
          .register(String(event.tournamentId ?? ""), playerIdsOf(event))
          .catch((e) => deps.log.error("no se pudo registrar el veto de torneo", { err: e }));
        continue;
      }
      // The CASUAL veto is the only one the switch can turn off. It is consulted here and not in the
      // scope because the switch belongs to matchmaking: it governs who is avoided when pairing.
      if (event.type === "CASUAL_PAIR_VETOED") {
        const playerIds = playerIdsOf(event);
        void deps
          .isCasualVetoEnabled()
          .then((enabled) => (enabled ? deps.veto.register(CASUAL_SCOPE, playerIds) : undefined))
          // The `.catch` is not one defence too many: in Node an unhandled rejection terminates the
          // process, and this sink runs when EVERY match closes.
          .catch((e) => deps.log.error("no se pudo registrar el veto casual", { err: e }));
      }
    }
  };
}

const playerIdsOf = (event: AnyEvent): readonly string[] =>
  Array.isArray(event.playerIds) ? (event.playerIds as string[]) : [];
