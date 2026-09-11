import { describe, expect, it } from "vitest";
import { InvariantViolationError } from "../../core/engine/errors.js";
import type { NetworkMatchEvent } from "../events.js";
import { MatchEventNotifier } from "../listeners.js";

describe("MatchEventNotifier", () => {
  it("difunde al cliente y a los sinks lo que el dominio produjo", () => {
    const broadcast: NetworkMatchEvent[] = [];
    const sink: NetworkMatchEvent[] = [];
    const notifier = new MatchEventNotifier([], (events) => broadcast.push(...events), [
      (events) => sink.push(...events),
    ]);

    notifier.notify([{ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }]);

    expect(broadcast).toHaveLength(1);
    expect(sink).toHaveLength(1);
  });

  it("los listeners pueden producir eventos, y esos también llegan a los sinks", () => {
    const sink: NetworkMatchEvent[] = [];
    const notifier = new MatchEventNotifier(
      [
        (event) =>
          event.type === "MATCH_RESOLVED" ? [{ type: "MATCH_ABORTED", reason: "INTERRUPTED" }] : [],
      ],
      () => {},
      [(events) => sink.push(...events)],
    );

    notifier.notify([{ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }]);

    expect(sink.map((e) => e.type)).toEqual(["MATCH_RESOLVED", "MATCH_ABORTED"]);
  });

  // DISYUNTOR. Un listener que reacciona a lo que él mismo produce cuelga la partida
  // en un bucle mudo. Superar el límite no es "quedó corto": es un ciclo.
  it("una cascada infinita de listeners rompe la invariante en vez de colgar", () => {
    const notifier = new MatchEventNotifier(
      [() => [{ type: "MATCH_ABORTED", reason: "INTERRUPTED" }]],
      () => {},
      [],
    );

    expect(() => notifier.notify([{ type: "MATCH_ABORTED", reason: "INTERRUPTED" }])).toThrow(
      InvariantViolationError,
    );
  });

  it("un lote vacío no llama a nadie", () => {
    let calls = 0;
    const notifier = new MatchEventNotifier([], () => calls++, [() => calls++]);
    notifier.notify([]);
    expect(calls).toBe(0);
  });
});
