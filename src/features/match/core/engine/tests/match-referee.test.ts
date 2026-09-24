// src/features/match/core/engine/tests/match-referee.test.ts
// Test DIRECTO contra MatchReferee, sin pasar por el comando. Es legítimo: el juez
// es de lectura pura sobre un árbol de estado, así que construir el estado que tiene
// que juzgar ES la forma honesta de probarlo.
//
// Por qué no alcanza con abandon.test.ts: ahí, en cuanto el primero abandona, el
// conductor saca a la partida de "PLAYING", y un segundo abandon() lo rechaza
// assertIsPlaying ANTES de llegar a outcome(). La rama "abandonaron los dos equipos"
// es HOY inalcanzable por el camino del comando — se vuelve alcanzable en la Tarea 19,
// cuando el vencimiento de la ventana de reparto puede retirar a varios jugadores de
// una sola vez. Sin este test, la guarda queda verde-y-muerta: se puede mover DESPUÉS
// del `for` —dead code— y los 63 tests de todos modos pasan.
import { describe, expect, it } from "vitest";
import { createMatchState } from "../genesis";
import { MatchReferee } from "../match/referee";
import { playerOf } from "../state-projections";
import { matchConfig } from "./match-config-fixture";

// SEAT_ORDER, a propósito, misma razón que en build-engine.ts: este test prueba la
// regla del juez, no el sorteo. Con SEAT_ORDER, "u1" es SIEMPRE team A y "u2" SIEMPRE
// team B. Es el default del fixture, y por eso no se pasa override.
const config = matchConfig(["u1", "u2"], { matchId: "m-referee-test" });

describe("MatchReferee.outcome — abandono", () => {
  it("si abandonaron los DOS equipos, no hay veredicto", () => {
    const match = createMatchState(config);
    playerOf("u1", match).hasAbandoned = true;
    playerOf("u2", match).hasAbandoned = true;

    expect(new MatchReferee(match).outcome()).toBeUndefined();
  });

  // El espejo del caso anterior: pin de la DISTINCIÓN, no solo de la guarda. Un
  // outcome() que devolviera siempre undefined pasaría el test de arriba igual.
  it("si abandonó UN equipo, gana el rival por ABANDONMENT", () => {
    const match = createMatchState(config);
    playerOf("u1", match).hasAbandoned = true;

    expect(new MatchReferee(match).outcome()).toEqual({
      winnerTeamId: "B",
      reason: "ABANDONMENT",
    });
  });
});
