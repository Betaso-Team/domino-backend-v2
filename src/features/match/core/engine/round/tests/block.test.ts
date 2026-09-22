import { describe, expect, it } from "vitest";
import type { TeamAssignmentMode } from "../../../config";
import { BoardState, BoneyardState, PlacedTile, RoundState, Tile } from "../../../state";
import { createMatchState } from "../../genesis";
import { handOf } from "../../state-projections";
import { matchConfig } from "../../tests/match-config-fixture";
import { blockVerdictOf, isBlocked } from "../block";

function build(
  handsBySeat: Record<string, [number, number][]>,
  boneyard: [number, number][] = [],
  teamAssignment: TeamAssignmentMode = "SHUFFLED",
) {
  const seats = Object.keys(handsBySeat);
  const match = createMatchState(matchConfig(seats, { seed: "s", teamAssignment }));
  const round = new RoundState();
  round.roundNumber = 1;
  round.phase = "PLAYING";
  round.board = new BoardState();
  const boneyardState = new BoneyardState();
  round.boneyard = boneyardState;

  const placedTile = new Tile();
  placedTile.left = 6;
  placedTile.right = 4;
  const placed = new PlacedTile();
  placed.tile = placedTile;
  placed.playedBy = seats[0] ?? "";
  placed.side = "RIGHT";
  round.board.tiles.push(placed);

  for (const [left, right] of boneyard) {
    const tile = new Tile();
    tile.left = left;
    tile.right = right;
    boneyardState.tiles.push(tile);
  }
  boneyardState.count = boneyardState.tiles.length;
  match.currentRound = round;

  for (const [playerId, tiles] of Object.entries(handsBySeat)) {
    const hand = handOf(playerId, match);
    for (const [left, right] of tiles) {
      const tile = new Tile();
      tile.left = left;
      tile.right = right;
      hand.tiles.push(tile);
    }
    hand.tileCount = hand.tiles.length;
  }
  return match;
}

describe("isBlocked", () => {
  it("no está trancado si alguien puede jugar", () => {
    expect(isBlocked(build({ u1: [[6, 1]], u2: [[3, 2]] }))).toBe(false);
  });

  it("no está trancado si el pozo contiene una ficha jugable", () => {
    expect(isBlocked(build({ u1: [[3, 2]], u2: [[5, 1]] }, [[6, 0]]))).toBe(false);
  });

  it("está trancado si las fichas del pozo tampoco pueden jugarse", () => {
    expect(isBlocked(build({ u1: [[3, 2]], u2: [[5, 1]] }, [[0, 0]]))).toBe(true);
  });

  it("está trancado si nadie puede jugar y el pozo está vacío", () => {
    expect(isBlocked(build({ u1: [[3, 2]], u2: [[5, 1]] }))).toBe(true);
  });

  it("una mano vacía no traba nada: eso es dominó, no tranca", () => {
    expect(isBlocked(build({ u1: [], u2: [[5, 1]] }))).toBe(false);
  });
});

describe("blockVerdictOf — reglas §3.7", () => {
  it("gana quien tiene menos puntos en la mano", () => {
    const verdict = blockVerdictOf(build({ u1: [[3, 2]], u2: [[5, 1]] }));
    expect(verdict).toEqual({ winnerId: "u1", isTie: false, points: 6 });
  });

  it("los puntos son la suma de TODAS las manos perdedoras", () => {
    const verdict = blockVerdictOf(
      build({
        u1: [[1, 0]],
        u2: [
          [5, 1],
          [4, 4],
        ],
      }),
    );
    expect(verdict).toEqual({ winnerId: "u1", isTie: false, points: 14 });
  });

  it("empate de puntos: no hay ganador y lo dice", () => {
    const verdict = blockVerdictOf(build({ u1: [[3, 2]], u2: [[4, 1]] }));
    expect(verdict).toEqual({ winnerId: undefined, isTie: true, points: 0 });
  });

  it("quien abandonó no compite por el menor conteo", () => {
    const match = build({ u1: [[6, 6]], u2: [[0, 1]] });
    const abandoned = match.players.find((player) => player.playerId === "u2");
    if (abandoned) abandoned.hasAbandoned = true;
    const verdict = blockVerdictOf(match);
    expect(verdict.winnerId).toBe("u1");
  });
});

// LA MESA DE CUATRO, que es donde «por equipo» y «por jugador» dejan de dar lo mismo. Con
// `SEAT_ORDER` las parejas son las de los asientos: u1+u3 = A, u2+u4 = B.
const buildFour = (handsBySeat: Record<string, [number, number][]>) =>
  build(handsBySeat, [], "SEAT_ORDER");

describe("blockVerdictOf — la tranca de la mesa de cuatro", () => {
  // ⚠ EL CASO QUE SEPARA LAS DOS REGLAS, y el único que hay que mirar si esto se rompe: u2
  // tiene la mano más chica de la mesa (1) y su pareja pierde igual, porque B suma 13 (1 + 12)
  // contra los 8 (5 + 3) de A. Contando por jugador ganaría B, que es el equipo con MÁS pips.
  it("gana el equipo con menos pips, aunque la mano más chica sea del otro", () => {
    const verdict = blockVerdictOf(
      buildFour({
        u1: [[3, 2]],
        u2: [[1, 0]],
        u3: [[2, 1]],
        u4: [[6, 6]],
      }),
    );

    expect(verdict.isTie).toBe(false);
    expect(["u1", "u3"]).toContain(verdict.winnerId);
  });

  // ⚠ LOS PUNTOS SON LOS DEL EQUIPO RIVAL Y NO «LOS DE TODOS MENOS EL GANADOR»: la mano del
  // COMPAÑERO no se cobra. Acá son 13 —el 1|0 de u2 más el 6|6 de u4— y no 18, que es lo que
  // daría sumando además el 3|2 de u1, que juega en el mismo bando que la cara del veredicto.
  it("cobra los pips del equipo rival, sin la mano del compañero", () => {
    const verdict = blockVerdictOf(
      buildFour({
        u1: [[3, 2]],
        u2: [[1, 0]],
        u3: [[2, 1]],
        u4: [[6, 6]],
      }),
    );

    expect(verdict.points).toBe(13);
  });

  // Los DOS suman 13, repartidos distinto: A lleva 5 + 8 y B lleva 7 + 6. Que el empate no
  // salga de manos idénticas es el punto — lo que se compara es el total de la pareja.
  it("empate entre equipos: no hay ganador ni puntos", () => {
    const verdict = blockVerdictOf(
      buildFour({
        u1: [[3, 2]],
        u2: [[6, 1]],
        u3: [[4, 4]],
        u4: [[5, 1]],
      }),
    );

    expect(verdict).toEqual({ winnerId: undefined, isTie: true, points: 0 });
  });

  // LA CARA DEL VEREDICTO ES DERIVADA Y DETERMINISTA: el del equipo ganador con menos pips.
  // No es cosmética — el replay tiene que reproducir el mismo `winnerId` en cada corrida.
  it("nombra al del equipo ganador que menos pips tiene", () => {
    const verdict = blockVerdictOf(
      buildFour({
        u1: [[6, 5]],
        u2: [[6, 6]],
        u3: [[1, 0]],
        u4: [[6, 6]],
      }),
    );

    expect(verdict.winnerId).toBe("u3");
  });
});
