// src/features/match/core/engine/tests/genesis.test.ts
import { describe, expect, it } from "vitest";
import { createMatchState } from "../genesis";
import { scoreboardOf } from "../state-projections";
// El test compara contra la política DIRECTAMENTE, y por eso la importa: así afirma que la
// génesis la DELEGA en vez de reimplementar `i % 2` y coincidir por casualidad.
import { assignTeams } from "../team-assignment";
import { matchConfig as config } from "./match-config-fixture";

// El fixture sortea con `SEAT_ORDER` por default; las tres pruebas del sorteo piden
// `SHUFFLED` explícito, que es lo que estaba bajo prueba desde siempre.
const SEED = "seed-test";

describe("createMatchState", () => {
  it("sienta a los jugadores en el orden de seats", () => {
    const match = createMatchState(config(["u1", "u2"]));
    expect(match.players.map((p) => p.playerId)).toEqual(["u1", "u2"]);
    expect(match.players.map((p) => p.seatIndex)).toEqual([0, 1]);
  });

  // El árbol copia del snapshot lo que se juega y se dibuja: perfil y `userId`. La moneda NO se
  // copia: es la que ya se cobró y se queda congelada en `config.seats`, de donde la lee la
  // liquidación (`payout.test.ts`), así que una recompensa no puede salir en otra moneda.
  it("copia perfil y userId, y no la moneda", () => {
    const match = createMatchState(config(["u1", "u2"]));
    expect(match.players[0]).toMatchObject({
      playerId: "u1",
      displayName: "Jugador u1",
      userId: "u1",
    });
    expect(match.players[0]).not.toHaveProperty("currency");
  });

  // La génesis NO decide los equipos: los delega en la política (spec §4.3). Lo que
  // este test protege es que los delegue de verdad y no reimplemente `i % 2`.
  it("aplica la política de equipos que dice el config", () => {
    const seats = ["u1", "u2", "u3", "u4"];
    const bySeat = createMatchState(config(seats, { teamAssignment: "SEAT_ORDER" }));
    expect(bySeat.players.map((p) => p.teamId)).toEqual(["A", "B", "A", "B"]);

    const shuffledMatch = createMatchState(config(seats, { teamAssignment: "SHUFFLED" }));
    expect(shuffledMatch.players.map((p) => p.teamId)).toEqual(
      assignTeams(seats, "SHUFFLED", SEED),
    );
  });

  it("con el mismo seed, las parejas sorteadas son siempre las mismas", () => {
    const seats = ["u1", "u2", "u3", "u4"];
    const shuffled = () =>
      createMatchState(config(seats, { teamAssignment: "SHUFFLED" })).players.map((p) => p.teamId);
    expect(shuffled()).toEqual(shuffled());
  });

  it("arranca en NOT_STARTED, sin ronda y sin marcador", () => {
    const match = createMatchState(config(["u1", "u2"]));
    expect(match.phase).toBe("NOT_STARTED");
    expect(match.currentRound).toBeUndefined();
    // `scoreboardOf` (state-projections.ts) angosta el opcional en un solo lugar; se usa
    // acá también para no tener dos formas de leer el mismo campo en el proyecto.
    expect(scoreboardOf(match).teamA).toBe(0);
    expect(scoreboardOf(match).teamB).toBe(0);
    expect(match.startedAt).toBe(0);
  });

  it("copia pointsToWin del config", () => {
    const match = createMatchState({ ...config(["u1", "u2"]), pointsToWin: 55 });
    expect(match.pointsToWin).toBe(55);
  });

  it("cada jugador nace con una mano vacía y no revelada", () => {
    const match = createMatchState(config(["u1", "u2"]));
    for (const player of match.players) {
      expect(player.hand.tiles.length).toBe(0);
      expect(player.hand.tileCount).toBe(0);
      expect(player.hand.isRevealed).toBe(false);
      expect(player.connected).toBe(true);
      expect(player.hasAbandoned).toBe(false);
    }
  });

  // La reserva de tiempo extra nace en 0 y la SIEMBRA el arranque de la partida
  // (`MatchDriver.begin`), que es quien tiene el `GlobalDominoConfig`. La génesis
  // recibe solo el config por partida, y no se le agrega un segundo parámetro para
  // esto: la reserva empieza a existir cuando la partida empieza, no cuando se
  // arma la mesa.
  it("la reserva de tiempo extra nace vacía; la siembra el arranque", () => {
    const match = createMatchState(config(["u1", "u2"]));
    for (const player of match.players) {
      expect(player.extraTimeRemainingMs).toBe(0);
    }
  });

  it("el seed NO entra al estado", () => {
    const match = createMatchState(config(["u1", "u2"]));
    expect(JSON.stringify(match.toJSON())).not.toContain(SEED);
  });

  // LA OTRA MITAD DEL SNAPSHOT: lo de infraestructura no entra al árbol. La moneda vive en el
  // `seat` de la config, no en el estado, así que no puede llegar al wire ni al fixture golden.
  // El `userId` sí entra: es como el cliente encuentra su asiento.
  it("el userId entra al árbol serializado y la moneda no", () => {
    const match = createMatchState(config(["u1", "u2"]));
    const wire = JSON.stringify(match.toJSON());

    expect(wire).toContain("Jugador u1");
    expect(match.toJSON().players.map((p: { userId: string }) => p.userId)).toEqual(["u1", "u2"]);
    expect(wire).not.toContain("VES");
  });
});

// EL MARCADOR INICIAL, sólo para probar a mano el final de una partida sin jugarla entera (truco
// `6da7372`). Se toma tal cual: mantenerlo por debajo de la meta es de quien llama, porque un equipo
// que naciera en ella habría ganado una partida que nadie jugó.
describe("createMatchState con marcador inicial", () => {
  it("nace con el marcador pedido", () => {
    const match = createMatchState(config(["u1", "u2"]), { teamA: 90, teamB: 15 });

    expect(scoreboardOf(match)).toMatchObject({ teamA: 90, teamB: 15 });
  });

  it("sin pedirlo nace en cero", () => {
    expect(scoreboardOf(createMatchState(config(["u1", "u2"])))).toMatchObject({
      teamA: 0,
      teamB: 0,
    });
  });
});
