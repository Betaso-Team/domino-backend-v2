import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it } from "vitest";
import { logSink } from "../log-sink";

// LA TRAZA DEL JUEGO. Lo que se mide es sobre todo lo que NO sale: el filtro existe para que el
// día que un evento lleve una ficha, la ficha no termine en el log de producción.

const traceOf = (events: Parameters<ReturnType<typeof logSink>>[0]) => {
  const log = new MemoryLogger();
  logSink(log)(events);
  return log.at_("debug");
};

describe("la traza de la partida", () => {
  it("apunta cada hecho con su tipo y sus campos", () => {
    const lines = traceOf([
      { type: "ABANDON", playerId: "seat-1" },
      { type: "DEADLINE_EXPIRED", kind: "TURN" },
    ]);

    expect(lines.map((line) => line.fields)).toEqual([
      { event: "ABANDON", playerId: "seat-1" },
      { event: "DEADLINE_EXPIRED", kind: "TURN" },
    ]);
    expect(lines.every((line) => line.msg === "hecho")).toBe(true);
  });

  // ⚠ EL `event` VA DESPUÉS de los campos del hecho, y no es cosmética: un hecho que trajera un
  // campo con ese mismo nombre taparía cuál era, y la traza diría que pasó otra cosa.
  it("el tipo del hecho le gana a un campo que se llame igual", () => {
    const lines = traceOf([{ type: "ABANDON", event: "mentira" } as never]);

    expect(lines[0]?.fields.event).toBe("ABANDON");
  });

  // LAS LISTAS DE IDS SÍ SALEN, y es donde este filtro es más ancho que el de truco: son lo único
  // interesante de los hechos que nombran gente, y una traza que no dice a quiénes alcanzó no
  // sirve para reconstruir nada.
  it("deja pasar las listas de asientos", () => {
    const lines = traceOf([{ type: "REMATCH_ACCEPTED", playerIds: ["seat-1", "seat-2"] }]);

    expect(lines[0]?.fields.playerIds).toEqual(["seat-1", "seat-2"]);
  });

  // ⚠ LOS OBJETOS NO SALEN, Y ES POR CONSTRUCCIÓN Y NO POR UNA LISTA DE CAMPOS PROHIBIDOS que
  // alguien tenga que mantener. Hoy ningún evento del dominó lleva una ficha —`PLAY_TILE` es un
  // COMANDO— pero el día que alguno la lleve, la lleva como objeto y no sale. Un log con las
  // fichas de una partida en curso convierte el acceso al panel en un vector de trampa.
  it("no registra un objeto, aunque venga en un hecho", () => {
    const lines = traceOf([
      { type: "ABANDON", playerId: "seat-1", tile: { left: 6, right: 6 } } as never,
    ]);

    expect(lines[0]?.fields).toEqual({ event: "ABANDON", playerId: "seat-1" });
  });

  // Y tampoco una LISTA de objetos, que es la otra forma en que una mano entera podría colarse.
  it("no registra una lista de objetos", () => {
    const lines = traceOf([{ type: "ABANDON", tiles: [{ left: 1, right: 2 }] } as never]);

    expect(lines[0]?.fields).toEqual({ event: "ABANDON" });
  });

  // `null` ES UN ESCALAR y sale: «este campo vino vacío» es información, y filtrarlo lo volvería
  // indistinguible de un campo que no existe.
  it("registra un null en vez de comérselo", () => {
    const lines = traceOf([{ type: "ROUND_RESOLVED", winnerTeamId: null } as never]);

    expect(lines[0]?.fields).toEqual({ event: "ROUND_RESOLVED", winnerTeamId: null });
  });
});
