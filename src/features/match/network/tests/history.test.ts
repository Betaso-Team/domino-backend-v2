import { describe, expect, it } from "vitest";
import type { Clock } from "../../core/engine/clock";
import { createMatchState } from "../../core/engine/genesis";
import { BoardState, BoneyardState, RoundState, Tile } from "../../core/state/index";
import { replayConfigOf } from "../../transports/match-contract";
import type { HistoryEntry, HistoryPort } from "../history";
import { MatchHistory } from "../history";

function build() {
  const recorded: HistoryEntry[] = [];
  // `drain` acá no mide nada —este doble escribe en un arreglo, así que nunca tiene nada en
  // vuelo—: está porque el puerto lo pide, y que lo pida es lo que hace que un adaptador
  // nuevo no pueda olvidarse de implementarlo. Lo cazó `tsc` y no vitest, que es el motivo
  // por el que el gate de este repo es el typecheck.
  const port: HistoryPort = {
    record: (entries) => recorded.push(...entries),
    drain: () => Promise.resolve(),
  };
  const clockBox = { now: 5_000 };
  const clock: Clock = { now: () => clockBox.now };
  // El config sale del CONTRATO y no se escribe a mano: es el único que sabe armar un
  // `DominoMatchConfig` válido, y este test no tiene nada que decir sobre su forma. Va por
  // `replayConfigOf` —la entrada del SNAPSHOT grabado— y no por `configOf`, que desde la Tarea 10
  // pide además el `GameMode` que el catálogo resolvió: el historial no consulta catálogos.
  const match = createMatchState(
    replayConfigOf({
      matchId: "m1",
      gameModeId: "g",
      seats: [
        {
          platformId: "betaso",
          userUuid: "u1",
          displayName: "Jugador u1",
          currency: "VES",
          playerId: "seat-1",
        },
        {
          platformId: "betaso",
          userUuid: "u2",
          displayName: "Jugador u2",
          currency: "VES",
          playerId: "seat-2",
        },
      ],
      seed: "s",
      pointsToWin: 100,
      teamAssignment: "SHUFFLED",
      isDealWindowEnabled: true,
      rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
      entryFee: 125,
      prize: 250,
    }),
  );
  const round = new RoundState();
  round.roundNumber = 3;
  round.board = new BoardState();
  round.boneyard = new BoneyardState();
  match.currentRound = round;
  return { history: new MatchHistory("m1", match, clock, port), recorded, clockBox };
}

// EL VOCABULARIO DE ESTOS TESTS ES EL DE HOY, no el final. El plan los escribió con
// PLAY_TILE y PASS —verbos que llegan recién en la Tarea 19—, y contra el catálogo
// actual (`CommandPayloads` = { ABANDON }) eso no compila: siete TS2345/TS2322.
//
// Y el modo en que NO se descubre es la parte que hay que recordar: vitest transpila
// con esbuild, que BORRA los tipos sin chequearlos, así que los seis tests daban verde
// mientras `tsc --noEmit` tenía siete errores. En este repo el test verde no es prueba
// de que compile; el gate es `npm run typecheck`.
//
// ABANDON alcanza para las seis propiedades, y para la del `source` alcanza MEJOR: es
// el único verbo que hoy existe de las dos bocas —comando voluntario y evento emitido
// por timeout— y core/events.ts lo documenta justamente como el caso canónico de la
// distinción ("se fue" contra "lo sacaron").
describe("MatchHistory", () => {
  // El punto central: actos y hechos INTERCALADOS con UN SOLO seq que los ordena
  // entre sí. Un registro de solo eventos tendría los desenlaces y ninguna jugada.
  it("intercala comandos y eventos con un solo seq monótono", () => {
    const { history, recorded } = build();
    history.command("PLAYER", "ABANDON", { playerId: "u1" });
    history.events([{ type: "DEADLINE_EXPIRED", kind: "TURN" }]);
    history.command("PLAYER", "ABANDON", { playerId: "u2" });

    expect(recorded.map((e) => [e.seq, e.source, e.type])).toEqual([
      [1, "PLAYER", "ABANDON"],
      [2, "SYSTEM", "DEADLINE_EXPIRED"],
      [3, "PLAYER", "ABANDON"],
    ]);
  });

  // El source es un campo y no un adorno: el mismo verbo puede venir de las dos
  // bocas, y para un reclamo —"yo nunca me fui, me sacaron"— esa es toda la pregunta.
  it("distingue el verbo del jugador del mismo verbo dicho por el sistema", () => {
    const { history, recorded } = build();
    history.command("PLAYER", "ABANDON", { playerId: "u1" });
    history.events([{ type: "ABANDON", playerId: "u2" }]);

    expect(recorded[0]).toMatchObject({ type: "ABANDON", source: "PLAYER", kind: "COMMAND" });
    expect(recorded[1]).toMatchObject({ type: "ABANDON", source: "SYSTEM", kind: "EVENT" });
  });

  it("envuelve cada entrada con matchId, timestamp del Clock y roundNumber", () => {
    const { history, recorded, clockBox } = build();
    clockBox.now = 7_777;
    history.command("PLAYER", "ABANDON", { playerId: "u1" });

    expect(recorded[0]).toMatchObject({ matchId: "m1", at: 7_777, roundNumber: 3 });
  });

  // En @colyseus/schema 5 los campos dejaron de ser propiedades propias del objeto,
  // así que { ...tile } devuelve {} y la ficha se registraría VACÍA. Sin este
  // aplanado el replay no puede reconstruir nada.
  it("aplana un Schema con toJSON en vez de spread", () => {
    const { history, recorded } = build();
    const tile = new Tile();
    tile.left = 6;
    tile.right = 4;
    history.command("PLAYER", "ABANDON", { playerId: "u1", tile });

    expect(recorded[0]?.payload).toEqual({ playerId: "u1", tile: { left: 6, right: 4 } });
  });

  it("aplana Schemas dentro de arrays", () => {
    const { history, recorded } = build();
    const a = new Tile();
    a.left = 1;
    a.right = 1;
    const b = new Tile();
    b.left = 2;
    b.right = 3;
    history.command("PLAYER", "ABANDON", { playerId: "u1", tiles: [a, b] });

    expect(recorded[0]?.payload).toEqual({
      playerId: "u1",
      tiles: [
        { left: 1, right: 1 },
        { left: 2, right: 3 },
      ],
    });
  });

  it("un lote de eventos consume un seq por evento", () => {
    const { history, recorded } = build();
    history.events([
      { type: "DEADLINE_EXPIRED", kind: "PRESENTING_MATCH" },
      { type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "ABANDONMENT" },
    ]);
    expect(recorded.map((e) => e.seq)).toEqual([1, 2]);
  });
});
