import { type TokenVerifier, authenticated } from "@/features/auth";
import type { Application } from "express";
import { z } from "zod";
import type { StrikeBook } from "../penalty";

// Validated like every other route: a handler never sees an `unknown`, and here the id also reaches a
// key built out of what the client sent.
const PenaltyParams = z.object({ tournamentId: z.string().min(1).max(64) });

/**
 * What the client is told about its own walkouts. TWO fields and not v1's four:
 * the countdown is derived from the deadline, and a remaining-seconds sent by the
 * server is born stale — the clock to compare against travels in the `Date` header
 * of this very response.
 *
 * `penalizedUntil` is `null` when nothing is being served, which is NOT the same as
 * having no strikes: the counter outlives the block, so a client can say "one
 * walkout so far, the next one costs you".
 */
interface PenaltyDTO {
  strikes: number;
  penalizedUntil: string | null;
}

/**
 * The tournament's inbound HTTP: one route, and it answers ABOUT WHOEVER ASKS.
 *
 * Hence `authenticated` and not a token check: the subject of the answer is the
 * bearer, so no further authorisation is needed and none is possible — there is no
 * way to ask about somebody else.
 *
 * It takes its pieces as parameters instead of resolving a container, like the
 * other registrars: composing is the entrypoint's job and this file is not one.
 */
export function registerTournamentHttp(
  app: Application,
  strikes: Pick<StrikeBook, "penaltyOf">,
  verifier: TokenVerifier,
): void {
  app.get(
    "/me/tournaments/:tournamentId/penalty",
    authenticated(verifier, { params: PenaltyParams }, async (identity, { params }, res) => {
      const { strikes: count, blockedUntil } = await strikes.penaltyOf(
        params.tournamentId,
        identity.userId,
      );
      const dto: PenaltyDTO = {
        strikes: count,
        penalizedUntil: blockedUntil > 0 ? new Date(blockedUntil).toISOString() : null,
      };
      res.json(dto);
    }),
  );
}
