import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONFIG } from "../../config.js";
import { RuleViolationError } from "../errors.js";
import { playerOf } from "../state-projections.js";
import { engineWithHands } from "./build-engine.js";

function engine() {
  const harness = engineWithHands({ u1: [[6, 6]], u2: [[5, 5]] }, [], {
    extraTimeReserveMs: DEFAULT_GLOBAL_CONFIG.extraTimeReserveMs,
  });
  return {
    ...harness,
    command: { execute: (payload: { playerId: string }) => harness.abandon(payload.playerId) },
  };
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
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 120);
    expect(e.scheduled.at(-1)).toBe(e.clockBox.now + 120);
    // El verbo dicho por el JUGADOR no emite evento —el comando ya es el registro—,
    // pero el VEREDICTO no es el verbo: es consecuencia computada, y sale acá.
    expect(events).toEqual([{ type: "MATCH_RESOLVED", winnerTeamId: "B", reason: "ABANDONMENT" }]);
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

  // LA RESERVA SE SIEMBRA UNA VEZ Y SOLO DECRECE (reglas §5.1, decisión 7). Es el único
  // lugar del motor que la escribe hacia arriba, así que es el único que puede regalarla.
  it("el arranque siembra la reserva de tiempo extra de cada jugador", () => {
    const e = engine();
    for (const player of e.match.players) expect(player.extraTimeRemainingMs).toBe(0);

    e.matchDriver.begin();

    for (const player of e.match.players) {
      expect(player.extraTimeRemainingMs).toBe(DEFAULT_GLOBAL_CONFIG.extraTimeReserveMs);
    }
  });

  // EL TEST TIENE QUE GASTAR LA RESERVA PRIMERO, y no es un detalle: una reserva intacta
  // y completa es INDISTINGUIBLE de una recién rellenada. Sin gastarla, este test pasaría
  // igual con la siembra corriendo en cada `begin()` — que es justo el bug que cuida.
  //
  // Qué se rompe si la guarda de idempotencia se mueve debajo del loop de siembra: el que
  // logre disparar un segundo arranque recupera su colchón entero, gratis.
  it("un segundo begin() NO rellena la reserva ya gastada", () => {
    const e = engine();
    e.matchDriver.begin();

    const spent = playerOf("u1", e.match);
    spent.extraTimeRemainingMs = 1_234;

    e.matchDriver.begin();

    expect(spent.extraTimeRemainingMs).toBe(1_234);
  });
});
