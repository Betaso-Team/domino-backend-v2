import { describe, expect, it } from "vitest";
import { AbandonCommand } from "../../commands/abandon.js";
import { RuleViolationError } from "../errors.js";
import { playerOf } from "../state-projections.js";
import { buildEngine } from "./build-engine.js";

function engine(seats?: string[]) {
  const harness = buildEngine(seats);
  const command = new AbandonCommand(harness.referee, harness.players, harness.matchDriver);
  return { ...harness, command };
}

describe("ABANDON", () => {
  it("no se puede abandonar una partida que no arrancó", () => {
    const { command } = engine();
    expect(() => command.execute({ playerId: "u1" })).toThrow(RuleViolationError);
  });

  // EL VEREDICTO SALE AL ENTRAR A LA PRESENTACIÓN, NO AL VENCERLA. El listener que paga
  // cuelga de `MATCH_RESOLVED`, así que si el evento saliera al final de la pausa el
  // premio esperaría los 6 s enteros —y con las fases de revancha, mucho más—. Este test
  // es el que fija esa latencia: el forfeit paga en el acto.
  it("marca al jugador, abre la pausa de cierre, y dictamina YA", () => {
    const e = engine();
    e.matchDriver.begin();
    expect(e.match.phase).toBe("PLAYING");

    const events = e.command.execute({ playerId: "u1" });

    expect(playerOf("u1", e.match).hasAbandoned).toBe(true);
    expect(e.match.phase).toBe("PRESENTING_MATCH");
    // El plazo se estampa en el estado Y se programa por el puerto.
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 6_000);
    expect(e.scheduled).toEqual([e.clockBox.now + 6_000]);
    // El verbo dicho por el JUGADOR no emite evento —el comando ya es el registro—,
    // pero el VEREDICTO no es el verbo: es consecuencia computada, y sale acá.
    expect(events).toEqual([{ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "ABANDONMENT" }]);
  });

  it("al vencer la pausa solo se cierra la máquina; el veredicto ya salió", () => {
    const e = engine();
    e.matchDriver.begin();
    e.command.execute({ playerId: "u1" });

    const events = e.fireTimeout();

    expect(e.match.phase).toBe("FINISHED");
    expect(events).toEqual([{ type: "DEADLINE_EXPIRED", kind: "PRESENTING_MATCH" }]);
  });

  it("abandonar dos veces es ilegal la segunda", () => {
    const e = engine();
    e.matchDriver.begin();
    e.command.execute({ playerId: "u1" });
    expect(() => e.command.execute({ playerId: "u1" })).toThrow(RuleViolationError);
  });

  it("begin() es idempotente: la sala lo llama en cada conexión", () => {
    const e = engine();
    e.matchDriver.begin();
    const startedAt = e.match.startedAt;
    e.clockBox.now += 5_000;
    e.matchDriver.begin();
    expect(e.match.startedAt).toBe(startedAt);
  });
});
