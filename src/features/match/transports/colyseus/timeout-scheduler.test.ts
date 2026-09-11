import type { Delayed } from "colyseus";
import { describe, expect, it, vi } from "vitest";
import type { MatchEvent } from "../../core/events.js";
import type { DeadlineKind } from "../../core/events.js";
import { RoomTimeoutScheduler } from "./timeout-scheduler.js";

type RecordedTimer = { callback: () => void; delay: number; cleared: boolean };

function recordingClock() {
  const timers: RecordedTimer[] = [];
  const clock = {
    setTimeout(callback: () => void, delay: number): Delayed {
      const timer: RecordedTimer = { callback, delay, cleared: false };
      timers.push(timer);
      return {
        clear: () => {
          timer.cleared = true;
        },
      } as Delayed;
    },
  };
  return {
    clock,
    timers,
    fire: (timer: RecordedTimer | undefined) => timer && !timer.cleared && timer.callback(),
  };
}

const expiry = (kind: DeadlineKind): readonly MatchEvent[] => [{ type: "DEADLINE_EXPIRED", kind }];

describe("RoomTimeoutScheduler", () => {
  it("programa y difunde el resultado al vencer", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { clock, timers, fire } = recordingClock();
    const emitted: Array<readonly MatchEvent[]> = [];
    const scheduler = new RoomTimeoutScheduler(clock, (events) => emitted.push(events));

    scheduler.schedule(1_250, () => expiry("TURN"));
    expect(timers[0]?.delay).toBe(250);

    fire(timers[0]);
    expect(emitted).toEqual([[{ type: "DEADLINE_EXPIRED", kind: "TURN" }]]);
    vi.restoreAllMocks();
  });

  it("reemplaza el timer anterior al programar de nuevo", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { clock, timers, fire } = recordingClock();
    const emitted: Array<readonly MatchEvent[]> = [];
    const scheduler = new RoomTimeoutScheduler(clock, (events) => emitted.push(events));

    scheduler.schedule(1_100, () => expiry("TURN"));
    scheduler.schedule(1_300, () => expiry("DEALING"));

    expect(timers[0]?.cleared).toBe(true);
    fire(timers[0]);
    fire(timers[1]);
    expect(emitted).toEqual([[{ type: "DEADLINE_EXPIRED", kind: "DEALING" }]]);
    vi.restoreAllMocks();
  });

  it("cancel evita la emisión y puede repetirse", () => {
    const { clock, timers, fire } = recordingClock();
    const emitted: Array<readonly MatchEvent[]> = [];
    const scheduler = new RoomTimeoutScheduler(clock, (events) => emitted.push(events));

    scheduler.schedule(Date.now() + 100, () => expiry("TURN"));
    scheduler.cancel();
    scheduler.cancel();
    fire(timers[0]);

    expect(timers[0]?.cleared).toBe(true);
    expect(emitted).toEqual([]);
  });

  it("usa delay cero si el deadline ya pasó", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const { clock, timers } = recordingClock();
    const scheduler = new RoomTimeoutScheduler(clock, () => {});

    scheduler.schedule(1_999, () => expiry("TURN"));

    expect(timers[0]?.delay).toBe(0);
    vi.restoreAllMocks();
  });
});
