// src/features/match/core/engine/tests/team-assignment.test.ts
import { describe, expect, it } from "vitest";
import { assignTeams } from "../team-assignment";

const seats4 = ["u1", "u2", "u3", "u4"];

describe("assignTeams — SEAT_ORDER", () => {
  it("alterna por índice de asiento", () => {
    expect(assignTeams(seats4, "SEAT_ORDER", "s")).toEqual(["A", "B", "A", "B"]);
  });

  it("no depende del seed", () => {
    expect(assignTeams(seats4, "SEAT_ORDER", "uno")).toEqual(
      assignTeams(seats4, "SEAT_ORDER", "dos"),
    );
  });
});

describe("assignTeams — SHUFFLED", () => {
  it("reparte exactamente la mitad a cada equipo", () => {
    const teams = assignTeams(seats4, "SHUFFLED", "seed-x");
    expect(teams.filter((team) => team === "A")).toHaveLength(2);
    expect(teams.filter((team) => team === "B")).toHaveLength(2);
  });

  // LA RESTRICCIÓN QUE HACE POSIBLE EL REPLAY. Sin esto, una partida jugada no se
  // puede reconstruir porque las parejas fueron un Math.random() que nadie guardó.
  it("es determinista: mismo seed, mismas parejas", () => {
    expect(assignTeams(seats4, "SHUFFLED", "seed-x")).toEqual(
      assignTeams(seats4, "SHUFFLED", "seed-x"),
    );
  });

  it("distinto seed da (en general) parejas distintas", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const results = new Set(seeds.map((seed) => assignTeams(seats4, "SHUFFLED", seed).join("")));
    // Con 8 semillas y 3 emparejamientos posibles, ver uno solo sería un PRNG roto.
    expect(results.size).toBeGreaterThan(1);
  });

  it("no depende del orden en que vengan los asientos para ser válido", () => {
    const teams = assignTeams(["z", "y", "x", "w"], "SHUFFLED", "seed-x");
    expect(teams).toHaveLength(4);
    expect(new Set(teams)).toEqual(new Set(["A", "B"]));
  });
});

describe("assignTeams — 2 asientos", () => {
  // Con dos jugadores las dos políticas coinciden: uno de cada equipo, siempre.
  it("los dos modos dan lo mismo", () => {
    expect(assignTeams(["u1", "u2"], "SEAT_ORDER", "s")).toEqual(["A", "B"]);
    expect(assignTeams(["u1", "u2"], "SHUFFLED", "s")).toEqual(["A", "B"]);
  });
});

describe("assignTeams — bordes", () => {
  it("una cantidad impar de asientos rompe la invariante", () => {
    expect(() => assignTeams(["u1", "u2", "u3"], "SHUFFLED", "s")).toThrow();
  });

  it("cero asientos rompe la invariante", () => {
    expect(() => assignTeams([], "SEAT_ORDER", "s")).toThrow();
  });
});
