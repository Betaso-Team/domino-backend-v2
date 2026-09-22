import type { Participation, ParticipationTransport } from "../participation";

// THE QUEUE, IN MEMORY: it records what was sent instead of returning nothing, because the tests
// assert on that. The failure LASTS until it is reverted, it is not single-use.

export class FakeParticipationTransport implements ParticipationTransport {
  readonly sent: Participation[] = [];
  private failing = false;

  setFailing(failing: boolean): void {
    this.failing = failing;
  }

  async send(participation: Participation): Promise<void> {
    if (this.failing) throw new Error("cola no disponible");
    this.sent.push(participation);
  }
}
