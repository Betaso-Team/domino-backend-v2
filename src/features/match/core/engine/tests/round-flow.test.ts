import { describe, expect, it } from "vitest";
import { currentTurnOf, scoreboardOf } from "../state-projections";
import { engineWithHands } from "./build-engine";

describe("flujo de la ronda", () => {
  it("reparte, elige quién arranca y entra en PLAYING", () => {
    const e = engineWithHands({
      u1: [
        [6, 6],
        [5, 4],
      ],
      u2: [
        [3, 2],
        [1, 0],
      ],
    });
    e.start();
    expect(e.round().phase).toBe("PLAYING");
    expect(currentTurnOf(e.round()).playerId).toBe("u1");
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 600);
  });

  it("jugar pasa el turno y re-arma el plazo", () => {
    const e = engineWithHands({
      u1: [
        [6, 6],
        [5, 4],
      ],
      u2: [
        [6, 3],
        [1, 0],
      ],
    });
    e.start();
    e.clockBox.now += 100;
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    expect(currentTurnOf(e.round()).playerId).toBe("u2");
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 600);
  });

  it("robar NO pasa el turno pero SÍ reinicia el plazo", () => {
    const e = engineWithHands(
      {
        u1: [
          [6, 6],
          [5, 4],
        ],
        u2: [
          [3, 2],
          [1, 0],
        ],
      },
      [[6, 1]],
    );
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    const before = e.match.activeDeadline;
    e.clockBox.now += 400;
    e.drawTile("u2");
    expect(currentTurnOf(e.round()).playerId).toBe("u2");
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 600);
    expect(e.match.activeDeadline).not.toBe(before);
    expect(e.hand("u2").tileCount).toBe(3);
  });

  it("robar no emite evento: el comando ya es el registro", () => {
    const e = engineWithHands(
      {
        u1: [
          [6, 6],
          [5, 4],
        ],
        u2: [
          [3, 2],
          [1, 0],
        ],
      },
      [[6, 1]],
    );
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    expect(e.drawTile("u2")).toEqual([]);
  });

  it("jugar la última ficha cierra por dominó y abre la pausa", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 3]] });
    e.start();
    const events = e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    expect(e.round().phase).toBe("PRESENTING_ROUND");
    expect(events).toEqual([
      {
        type: "ROUND_RESOLVED",
        roundNumber: 1,
        winnerId: "u1",
        winnerTeamId: "A",
        points: 9,
        reason: "DOMINO",
      },
    ]);
    expect(scoreboardOf(e.match).teamA).toBe(9);
    expect(e.hand("u1").isRevealed).toBe(true);
    expect(e.hand("u2").isRevealed).toBe(true);
  });

  it("la pausa de la mano es una fase con plazo, y al vencer arranca la ronda 2", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 3]] });
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 120);
    e.fireTimeout();
    expect(e.round().roundNumber).toBe(2);
    expect(e.round().phase).toBe("PLAYING");
    expect(e.match.pastRounds.length).toBe(1);
    expect(e.hand("u1").isRevealed).toBe(false);
    expect(e.hand("u2").isRevealed).toBe(false);
  });

  it("la ventana de reparto espera a que ambos levanten sus fichas", () => {
    const e = engineWithHands(
      {
        u1: [
          [6, 6],
          [5, 4],
        ],
        u2: [
          [3, 2],
          [1, 0],
        ],
      },
      [],
      { isDealWindowEnabled: true },
    );
    e.start();
    expect(e.round().phase).toBe("DEALING");
    e.revealTiles("u1");
    expect(e.round().phase).toBe("DEALING");
    e.revealTiles("u2");
    expect(e.round().phase).toBe("PLAYING");
  });

  it("al vencer la ventana retira al que no levantó sus fichas", () => {
    const e = engineWithHands(
      {
        u1: [
          [6, 6],
          [5, 4],
        ],
        u2: [
          [3, 2],
          [1, 0],
        ],
      },
      [],
      { isDealWindowEnabled: true },
    );
    e.start();
    e.revealTiles("u1");
    const events = e.fireTimeout();
    expect(events).toContainEqual({ type: "DEADLINE_EXPIRED", kind: "DEALING" });
    expect(events).toContainEqual({ type: "ABANDON", playerId: "u2" });
    expect(events).toContainEqual({
      type: "MATCH_RESOLVED",
      winnerTeamId: "A",
      reason: "ABANDONMENT",
    });
  });

  it("si nadie levanta sus fichas apaga el plazo sin inventar ganador", () => {
    const e = engineWithHands(
      {
        u1: [
          [6, 6],
          [5, 4],
        ],
        u2: [
          [3, 2],
          [1, 0],
        ],
      },
      [],
      { isDealWindowEnabled: true },
    );
    e.start();
    const events = e.fireTimeout();
    expect(events.filter((event) => event.type === "ABANDON")).toHaveLength(2);
    expect(events.some((event) => event.type === "MATCH_RESOLVED")).toBe(false);
    expect(e.match.activeDeadline).toBe(0);
    expect(() => e.fireTimeout()).toThrow("no hay timeout programado");
  });

  it("el primer vencimiento consume la reserva y el segundo retira", () => {
    const e = engineWithHands(
      {
        u1: [[6, 6]],
        u2: [[6, 3]],
      },
      [],
      { extraTimeReserveMs: 300 },
    );
    e.start();
    expect(e.fireTimeout()).toEqual([{ type: "DEADLINE_EXPIRED", kind: "TURN" }]);
    expect(e.match.players.find((player) => player.playerId === "u1")?.extraTimeRemainingMs).toBe(
      0,
    );
    expect(currentTurnOf(e.round()).isConsumingExtendedTime).toBe(true);
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 300);
    expect(e.fireTimeout().map((event) => event.type)).toContain("ABANDON");
  });

  it("devuelve la reserva no usada cuando el jugador actúa", () => {
    const e = engineWithHands(
      {
        u1: [[6, 6]],
        u2: [[6, 3]],
      },
      [],
      { extraTimeReserveMs: 300 },
    );
    e.start();
    e.fireTimeout();
    e.clockBox.now += 100;
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    expect(e.match.players.find((player) => player.playerId === "u1")?.extraTimeRemainingMs).toBe(
      200,
    );
  });

  it("al vencer el turno se retira al jugador y se EMITE el ABANDON", () => {
    const e = engineWithHands({
      u1: [
        [6, 6],
        [5, 4],
      ],
      u2: [
        [6, 3],
        [1, 0],
      ],
    });
    e.start();
    const events = e.fireTimeout();
    expect(events[0]).toEqual({ type: "DEADLINE_EXPIRED", kind: "TURN" });
    expect(events[1]).toEqual({ type: "ABANDON", playerId: "u1" });
    expect(e.match.players.find((p) => p.playerId === "u1")?.hasAbandoned).toBe(true);
  });

  it("el ABANDON voluntario no emite evento; el del timeout sí", () => {
    const voluntary = engineWithHands({
      u1: [
        [6, 6],
        [5, 4],
      ],
      u2: [
        [6, 3],
        [1, 0],
      ],
    });
    voluntary.start();
    expect(voluntary.abandon("u1").some((event) => event.type === "ABANDON")).toBe(false);
    const forced = engineWithHands({
      u1: [
        [6, 6],
        [5, 4],
      ],
      u2: [
        [6, 3],
        [1, 0],
      ],
    });
    forced.start();
    expect(forced.fireTimeout().map((event) => event.type)).toContain("ABANDON");
  });

  it("retirar al jugador en 2P resuelve la partida por forfeit", () => {
    const e = engineWithHands({
      u1: [
        [6, 6],
        [5, 4],
      ],
      u2: [
        [6, 3],
        [1, 0],
      ],
    });
    e.start();
    const events = e.fireTimeout();
    expect(e.match.phase).toBe("PRESENTING_MATCH");
    expect(events).toContainEqual({
      type: "MATCH_RESOLVED",
      winnerTeamId: "B",
      reason: "ABANDONMENT",
    });
    const closingEvents = e.fireTimeout();
    expect(e.match.phase).toBe("FINISHED");
    expect(closingEvents).toEqual([{ type: "DEADLINE_EXPIRED", kind: "PRESENTING_MATCH" }]);
  });

  it("cierra por tranca cuando nadie puede jugar y el pozo está vacío", () => {
    const e = engineWithHands({
      u1: [
        [6, 6],
        [5, 5],
      ],
      u2: [
        [3, 2],
        [1, 0],
      ],
    });
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    e.pass("u2");
    const events = e.pass("u1");
    expect(e.round().phase).toBe("PRESENTING_ROUND");
    expect(events).toEqual([
      {
        type: "ROUND_RESOLVED",
        roundNumber: 1,
        winnerId: "u2",
        winnerTeamId: "B",
        points: 10,
        reason: "BLOCKED",
      },
    ]);
  });

  it("una tranca empatada emite ganador y equipo vacíos", () => {
    const e = engineWithHands({
      u1: [
        [6, 6],
        [5, 5],
      ],
      u2: [
        [4, 3],
        [2, 1],
      ],
    });
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    e.pass("u2");
    expect(e.pass("u1")).toEqual([
      {
        type: "ROUND_RESOLVED",
        roundNumber: 1,
        winnerId: "",
        winnerTeamId: "",
        points: 0,
        reason: "BLOCKED",
      },
    ]);
  });

  it("alcanzar pointsToWin cierra la partida en vez de abrir otra ronda", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 3]] });
    e.match.pointsToWin = 9;
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    const events = e.fireTimeout();
    expect(e.match.phase).toBe("PRESENTING_MATCH");
    expect(events).toContainEqual({ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" });
    const closingEvents = e.fireTimeout();
    expect(e.match.phase).toBe("FINISHED");
    expect(closingEvents).toEqual([{ type: "DEADLINE_EXPIRED", kind: "PRESENTING_MATCH" }]);
  });
});
