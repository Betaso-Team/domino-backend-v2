import type { AmqpDelivery } from "@/shared/amqp";
import type { Participation, ParticipationTransport } from "../participation";

// THE REPORT, over the queue. On the other side an `@EventPattern` receives it, so it travels with an
// envelope and to the queue that microservice declared: nothing is declared here, because declaring
// it with options different from theirs would kill the channel.
const QUEUE = "tournaments_queue";
const PATTERN = "tournament.save-participation";

/**
 * THE VOCABULARY TRANSLATION, which is why this class exists instead of
 * publishing the participation as-is: inside, a player and a match have our
 * names; to the main backend they have theirs. The port speaks the truco's
 * language and the transport the other side's, which is exactly the seam that
 * keeps changing backend from touching the reporter.
 */
export class AmqpParticipationTransport implements ParticipationTransport {
  constructor(private readonly publisher: AmqpDelivery) {}

  async send(participation: Participation): Promise<void> {
    // The delivery error comes out raw on purpose: the only thing that looks at it is the reporter's
    // retry loop, and all it asks is whether it landed.
    await this.publisher.publishPattern(QUEUE, PATTERN, {
      tournamentId: participation.tournamentId,
      roomId: participation.matchId,
      userId: participation.playerId,
      username: participation.username,
      profilePicture: participation.profilePicture,
      score: participation.score,
      matchScore: participation.matchScore,
      wins: participation.wins,
      losses: participation.losses,
      gamesPlayed: participation.gamesPlayed,
      // The TRAIL of why the score was what it was. Declaring these four fields and never sending
      // them leaves the operator unable to answer "why did this match give me 1 point?". The
      // consumer validates no schema and passes the whole object on, so they travel.
      roundsPlayed: participation.roundsPlayed,
      durationMs: participation.durationMs,
      qualityRatio: participation.qualityRatio,
      grade: participation.grade,
    });
  }
}
