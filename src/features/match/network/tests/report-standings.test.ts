import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../../logger.js";
import type { DominoMatchConfig } from "../../core/config.js";
import { createMatchState } from "../../core/engine/genesis.js";
import { matchConfig } from "../../core/engine/tests/match-config-fixture.js";
import type { MatchState } from "../../core/state/index.js";
import { reportStandings } from "../report-standings.js";
import type { LeagueResult, RankingParticipation } from "../standings.js";

// Las identidades de plataforma de los dos asientos. El `playerId` interno es `u1`/`u2` (el fixture
// del motor), y la diferencia entre ESE id y el `userUuid` es justamente lo que estos tests miden.
const SEATS = [
  { playerId: "u1", userUuid: "uuid-ganador", username: "gana", profilePicture: "foto.png" },
  { playerId: "u2", userUuid: "uuid-perdedor", username: "pierde" },
];

function fakeLogger(): Logger {
  const self: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => self,
  };
  return self;
}

interface Harness {
  readonly config: DominoMatchConfig;
  readonly match: MatchState;
  readonly won: RankingParticipation[];
  readonly recorded: LeagueResult[];
  readonly log: Logger;
  readonly resolve: () => void;
}

function harness(
  overrides: Partial<DominoMatchConfig> = {},
  options: { readonly noRanking?: boolean; readonly noLeagues?: boolean } = {},
): Harness {
  const base = matchConfig(["u1", "u2"], { multiplier: 3, ...overrides });
  const config: DominoMatchConfig = {
    ...base,
    seats: base.seats.map((seat, index) => ({ ...seat, ...SEATS[index] })),
  };
  const match = createMatchState(config);
  // El ganador es el equipo de `u1`. `SEAT_ORDER` es el default del fixture, así que u1 es "A".
  const won: RankingParticipation[] = [];
  const recorded: LeagueResult[] = [];
  const log = fakeLogger();
  const listener = reportStandings({
    config,
    match,
    ranking: options.noRanking
      ? undefined
      : {
          async won(entry) {
            won.push(entry);
          },
        },
    leagues: options.noLeagues
      ? undefined
      : {
          async record(result) {
            recorded.push(result);
          },
        },
    log,
  });

  return {
    config,
    match,
    won,
    recorded,
    log,
    resolve: () => {
      const produced = listener({ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" });
      // NO PRODUCE EVENTOS, y se asserta en cada corrida: un evento devuelto acá entraría a la
      // cascada del notificador sin que nadie lo consuma.
      expect(produced).toEqual([]);
    },
  };
}

// El reporte es fire-and-forget: el listener no lo espera, así que los tests tienen que dejar
// correr la microcola antes de mirar. Es la propiedad que se quiere —el cierre de la partida no
// puede esperar a dos servicios— y el precio es este `await` en la suite.
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reportStandings", () => {
  it("le cuenta la victoria al ranking con la identidad de PLATAFORMA, no con el asiento", async () => {
    const h = harness();
    h.resolve();
    await settled();

    expect(h.won).toHaveLength(1);
    // `uuid-ganador` y NO `u1`: el `playerId` es opaco y posicional, idéntico en todas las mesas,
    // así que mandarlo como `userId` le sumaría los puntos de todo el mundo a una cuenta inventada.
    expect(h.won[0]?.userUuid).toBe("uuid-ganador");
    expect(h.won[0]?.opponentUuids).toEqual(["uuid-perdedor"]);
  });

  it("los puntos son el peso del modo cuando no hubo aumento, y sin traza", async () => {
    const h = harness();
    h.resolve();
    await settled();

    expect(h.won[0]?.multiplier).toBe(3);
    expect(h.won[0]?.betIncrease).toBeUndefined();
  });

  // LA FÓRMULA DE v1, y es la diferencia con truco: allá el aumento NO pesa en el ranking. Acá
  // suma, y la traza viaja para soporte.
  it("con aumento aceptado los puntos SUMAN el extra y va la traza", async () => {
    const h = harness();
    h.match.acceptedBetLevel = 2;
    h.match.acceptedBetExtra = 2;
    h.resolve();
    await settled();

    expect(h.won[0]?.multiplier).toBe(5);
    expect(h.won[0]?.betIncrease).toEqual({ level: 2, extra: 2, baseMultiplier: 3 });
  });

  it("le cuenta el resultado a la liga con los dos lados", async () => {
    const h = harness();
    h.resolve();
    await settled();

    expect(h.recorded).toEqual([
      {
        winner: { userUuid: "uuid-ganador", username: "gana", profilePicture: "foto.png" },
        // `null` y no `""`: un invitado sin foto manda null, que es lo que v1 manda y lo que del
        // otro lado distingue "no tiene" de "tiene una vacía".
        losers: [{ userUuid: "uuid-perdedor", username: "pierde", profilePicture: null }],
      },
    ]);
  });

  // LA ASIMETRÍA DE v1, y es el motivo de que sean dos puertos y no uno: la llamada al ranking
  // está adentro del `if (!isFreeRoom)` y la de la liga queda afuera.
  it("una mesa gratis no suma al ranking pero SÍ cuenta para la liga", async () => {
    const h = harness({ isFreeRoom: true });
    h.resolve();
    await settled();

    expect(h.won).toEqual([]);
    expect(h.recorded).toHaveLength(1);
  });

  it("sin destino de ranking la liga se reporta igual", async () => {
    const h = harness({}, { noRanking: true });
    h.resolve();
    await settled();

    expect(h.recorded).toHaveLength(1);
    expect(h.log.debug).toHaveBeenCalled();
  });

  it("sin destino de liga el ranking se reporta igual", async () => {
    const h = harness({}, { noLeagues: true });
    h.resolve();
    await settled();

    expect(h.won).toHaveLength(1);
    expect(h.log.debug).toHaveBeenCalled();
  });

  // NO REPORTA LO QUE NO ES UN CIERRE CON VEREDICTO. `MATCH_ABORTED` reembolsa por otro camino y
  // no tiene ganador, así que un ranking de victorias y una tabla de liga no tienen qué recibir.
  it("ignora los eventos que no son el cierre con ganador", async () => {
    const h = harness();
    const listener = reportStandings({
      config: h.config,
      match: h.match,
      ranking: { async won() {} },
      leagues: { async record() {} },
      log: h.log,
    });
    expect(listener({ type: "MATCH_ABORTED", reason: "INTERRUPTED" })).toEqual([]);
    expect(listener({ type: "DEADLINE_EXPIRED", kind: "TURN" })).toEqual([]);
    await settled();
    expect(h.won).toEqual([]);
    expect(h.recorded).toEqual([]);
  });

  // UN REPORTE QUE FALLA NO PUEDE TUMBAR EL CIERRE. El veredicto ya salió al cliente y la plata va
  // por otro camino: una fila que falta en una tabla de puntos no es una partida rota.
  it("un destino que falla se anota y no propaga", async () => {
    const log = fakeLogger();
    const base = matchConfig(["u1", "u2"]);
    const config: DominoMatchConfig = {
      ...base,
      seats: base.seats.map((seat, index) => ({ ...seat, ...SEATS[index] })),
    };
    const listener = reportStandings({
      config,
      match: createMatchState(config),
      ranking: {
        async won() {
          throw new Error("el broker no contesta");
        },
      },
      leagues: { async record() {} },
      log,
    });

    expect(() =>
      listener({ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }),
    ).not.toThrow();
    await settled();
    expect(log.error).toHaveBeenCalled();
  });
});
