import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONFIG } from "../../core/config";
import type { Clock } from "../../core/engine/clock";
import { createMatchState } from "../../core/engine/genesis";
import { BoardState, BoneyardState, RoundState, Tile } from "../../core/state";
import { replayConfigOf } from "../../transports/match-contract";
import type { SeatConnection } from "../connection";
import type {
  ClosedRound,
  HistoryEntry,
  HistoryPort,
  MatchClose,
  MatchClosing,
  MatchOpening,
} from "../history";
import { MatchHistory } from "../history";
import { matchSetupOf } from "../match-record";

// UN PUERTO QUE ANOTA, EN ORDEN, cada verbo que le llega: lo que se mide del grabador es QUÉ le dice
// al puerto y en qué orden, no cómo lo guarda nadie.
type Call =
  | { readonly verb: "open"; readonly opening: MatchOpening }
  | { readonly verb: "record"; readonly entries: readonly HistoryEntry[] }
  | { readonly verb: "round"; readonly round: ClosedRound }
  | { readonly verb: "close"; readonly closing: MatchClosing };

function build() {
  const recorded: HistoryEntry[] = [];
  const calls: Call[] = [];
  // `drain` acá no mide nada —este doble escribe en un arreglo, así que nunca tiene nada en
  // vuelo—: está porque el puerto lo pide, y que lo pida es lo que hace que un adaptador
  // nuevo no pueda olvidarse de implementarlo. Lo cazó `tsc` y no vitest, que es el motivo
  // por el que el gate de este repo es el typecheck.
  const port: HistoryPort = {
    open: (_matchId, opening) => calls.push({ verb: "open", opening }),
    record: (entries) => {
      recorded.push(...entries);
      calls.push({ verb: "record", entries });
    },
    round: (_matchId, round) => calls.push({ verb: "round", round }),
    close: (_matchId, closing) => calls.push({ verb: "close", closing }),
    drain: () => Promise.resolve(),
  };
  const clockBox = { now: 5_000 };
  const clock: Clock = { now: () => clockBox.now };
  // El config sale del CONTRATO y no se escribe a mano: es el único que sabe armar un
  // `DominoMatchConfig` válido, y este test no tiene nada que decir sobre su forma. Va por
  // `replayConfigOf` —la entrada del SNAPSHOT grabado— y no por `configOf`, que desde la Tarea 10
  // pide además el `GameMode` que el catálogo resolvió: el historial no consulta catálogos.
  const config = replayConfigOf({
    matchId: "m1",
    gameModeId: "g",
    seats: [
      {
        userId: "u1",
        displayName: "Jugador u1",
        currency: "VES",
        playerId: "seat-1",
      },
      {
        userId: "u2",
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
  });
  const match = createMatchState(config);
  const setup = matchSetupOf(config, DEFAULT_GLOBAL_CONFIG, match, {
    roomId: "room-1",
    gameModeName: "Clásica",
  });
  const round = new RoundState();
  round.roundNumber = 3;
  round.starterId = "seat-2";
  round.board = new BoardState();
  round.boneyard = new BoneyardState();
  match.currentRound = round;
  return {
    history: new MatchHistory("m1", match, clock, port, setup),
    recorded,
    calls,
    clockBox,
    match,
    setup,
  };
}

const tile = (left: number, right: number) => Object.assign(new Tile(), { left, right });

const ENDING: MatchClose = {
  status: "finished",
  matchEndReason: "SCORE",
  winnerTeamId: "A",
  winnerIds: ["seat-1"],
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  money: {
    "seat-1": { chargedInUC: 125, prizePaidInUC: 250 },
    "seat-2": { chargedInUC: 125, prizePaidInUC: 0 },
  },
  betMultiplier: { offeredValues: [], finalValue: 1 },
  rankingMultiplier: { base: 1, extra: 0, final: 1 },
};

const closingOf = (calls: readonly Call[]) =>
  calls.flatMap((call) => (call.verb === "close" ? [call.closing] : []));

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
    history.events([{ type: "ROUND_STARTED", roundNumber: 3 }]);
    clockBox.now = 7_777;
    history.command("PLAYER", "ABANDON", { playerId: "u1" });

    expect(recorded.at(-1)).toMatchObject({ matchId: "m1", at: 7_777, roundNumber: 3 });
  });

  // EL REPARTO NO ES UN EVENTO —los eventos llegan a la mesa y éste le daría a cada uno las fichas
  // de todos— así que el grabador lo fotografía del árbol en el instante en que se anuncia la mano,
  // antes de que nadie pueda jugar ni robar (truco `b5bb427`).
  it("detrás de ROUND_STARTED graba las manos y el pozo tal como se repartieron", () => {
    const { history, recorded, match } = build();
    const tile = (left: number, right: number) => Object.assign(new Tile(), { left, right });
    match.players[0]?.hand.tiles.push(tile(6, 6), tile(3, 1));
    match.players[1]?.hand.tiles.push(tile(5, 4), tile(2, 0));
    match.currentRound?.boneyard?.tiles.push(tile(1, 1));

    history.events([{ type: "ROUND_STARTED", roundNumber: 1 }]);

    expect(recorded.map((e) => [e.seq, e.source, e.kind, e.type, e.roundNumber])).toEqual([
      [1, "SYSTEM", "EVENT", "ROUND_STARTED", 1],
      [2, "SYSTEM", "EVENT", "TILES_DEALT", 1],
    ]);
    expect(recorded[1]?.payload).toEqual({
      hands: [
        {
          playerId: "seat-1",
          tiles: [
            { left: 6, right: 6 },
            { left: 3, right: 1 },
          ],
        },
        {
          playerId: "seat-2",
          tiles: [
            { left: 5, right: 4 },
            { left: 2, right: 0 },
          ],
        },
      ],
      boneyard: [{ left: 1, right: 1 }],
    });
  });

  // El lote que vence la pausa de una mano también reparte la siguiente, así que cuando se graba el
  // árbol ya apunta a la nueva: leída del estado, el vencimiento quedaba en la mano que no cerró.
  it("el vencimiento de la pausa queda en SU mano aunque el mismo lote reparta la siguiente", () => {
    const { history, recorded } = build();
    history.events([{ type: "ROUND_STARTED", roundNumber: 1 }]);

    history.events([
      { type: "DEADLINE_EXPIRED", kind: "PRESENTING_ROUND" },
      { type: "ROUND_STARTED", roundNumber: 2 },
    ]);

    expect(recorded.map((e) => [e.type, e.roundNumber])).toEqual([
      ["ROUND_STARTED", 1],
      ["TILES_DEALT", 1],
      ["DEADLINE_EXPIRED", 1],
      ["ROUND_STARTED", 2],
      ["TILES_DEALT", 2],
    ]);
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

// EL REGISTRO v2.1 (truco `bed0d33`): la cabecera al arrancar, las manos al cerrarse y el desenlace
// una sola vez. Lo que se mide es el orden en que el grabador le habla al puerto, que es el orden en
// que el documento se escribe.
describe("MatchHistory: el registro de la partida", () => {
  it("abre al primer reparto, con el armado entero, ANTES de grabar el lote", () => {
    const { history, calls, match } = build();
    match.startedAt = 4_000;

    history.events([{ type: "ROUND_STARTED", roundNumber: 1 }]);

    expect(calls.map((call) => call.verb)).toEqual(["open", "record"]);
    const opening = calls[0]?.verb === "open" ? calls[0].opening : undefined;
    expect(opening).toMatchObject({
      roomId: "room-1",
      matchStartedAt: 4_000,
      table: {
        gameModeId: "g",
        name: "Clásica",
        entryFeeInUC: 125,
        prizeInUC: 250,
        isFree: false,
      },
      // LO QUE EL REPLAY NECESITA Y TRUCO NO GUARDA: sin el seed y las parejas la partida grabada
      // no se puede rebobinar.
      matchConfig: {
        playersQuantity: 2,
        pointsToWin: 100,
        seed: "s",
        teamAssignment: "SHUFFLED",
        isDealWindowEnabled: true,
        startingScore: { teamA: 0, teamB: 0 },
      },
    });
    expect(opening?.seats.map((seat) => [seat.id, seat.userId, seat.seat])).toEqual([
      ["seat-1", "u1", 0],
      ["seat-2", "u2", 1],
    ]);
    // El equipo es el que la génesis sorteó con el seed, no el orden de asiento.
    expect(opening?.seats.map((seat) => seat.teamId)).toEqual(
      match.players.map((player) => player.teamId),
    );
  });

  it("abre una sola vez: el reparto de la segunda mano no reescribe la cabecera", () => {
    const { history, calls } = build();
    history.events([{ type: "ROUND_STARTED", roundNumber: 1 }]);
    history.events([{ type: "ROUND_STARTED", roundNumber: 2 }]);

    expect(calls.filter((call) => call.verb === "open")).toHaveLength(1);
  });

  // LO QUE LAS REGLAS CONCLUYERON y la secuencia no dice sin reimplementarlas: quién salió y qué le
  // quedó a cada uno, con sus pips (`e4e630c`). El veredicto ya está en la timeline.
  it("archiva la mano al resolverse, leída del árbol antes del próximo reparto", () => {
    const { history, calls, match } = build();
    match.players[0]?.hand.tiles.push(tile(6, 5));
    match.players[1]?.hand.tiles.push(tile(1, 0), tile(2, 2));

    history.events([
      {
        type: "ROUND_RESOLVED",
        roundNumber: 3,
        winnerId: "seat-1",
        winnerTeamId: "A",
        points: 5,
        reason: "BLOCKED",
      },
    ]);

    expect(calls.map((call) => call.verb)).toEqual(["record", "round"]);
    expect(calls[1]).toEqual({
      verb: "round",
      round: {
        roundNumber: 3,
        endReason: "BLOCKED",
        starterId: "seat-2",
        hands: [
          { playerId: "seat-1", tiles: [{ left: 6, right: 5 }], pips: 11 },
          {
            playerId: "seat-2",
            tiles: [
              { left: 1, right: 0 },
              { left: 2, right: 2 },
            ],
            pips: 5,
          },
        ],
      },
    });
  });

  it("la mano que un abandono cortó también queda, y la ya resuelta no se archiva dos veces", () => {
    const { history, calls } = build();
    history.events([{ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "ABANDONMENT" }]);
    history.events([{ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "ABANDONMENT" }]);

    const rounds = calls.flatMap((call) => (call.verb === "round" ? [call.round] : []));
    expect(rounds.map((round) => [round.roundNumber, round.endReason])).toEqual([
      [3, "MATCH_ABANDONED"],
    ]);
  });

  it("cierra con el armado, la duración, el marcador y la plata de cada asiento", () => {
    const { history, calls, clockBox, match } = build();
    match.startedAt = 4_000;
    history.events([{ type: "ROUND_STARTED", roundNumber: 1 }]);
    if (match.scoreboard) match.scoreboard.teamA = 100;
    clockBox.now = 64_000;

    history.close(ENDING);

    const [closing] = closingOf(calls);
    expect(closing).toMatchObject({
      roomId: "room-1",
      status: "finished",
      matchStartedAt: 4_000,
      matchEndedAt: 64_000,
      matchDurationInMs: 60_000,
      matchEndReason: "SCORE",
      winnerTeamId: "A",
      winnerIds: ["seat-1"],
      rateId: ENDING.rateId,
      betMultiplier: { offeredValues: [], finalValue: 1, proposals: [] },
      rankingMultiplier: { base: 1, extra: 0, final: 1 },
    });
    const seat1 = closing?.players.find((player) => player.id === "seat-1");
    expect(seat1).toMatchObject({
      userId: "u1",
      currency: "VES",
      finalScore: match.players[0]?.teamId === "A" ? 100 : 0,
      chargedInUC: 125,
      prizePaidInUC: 250,
    });
  });

  // UNA MESA QUE NUNCA SE LLENÓ no tuvo reparto, así que nunca abrió: el cierre trae el armado él
  // mismo, y no inventa un arranque.
  it("una partida abortada sin abrir cierra igual, con el armado y sin arranque", () => {
    const { history, calls } = build();

    history.close({ ...ENDING, status: "aborted", matchEndReason: "NEVER_STARTED", winnerIds: [] });

    expect(calls.map((call) => call.verb)).toEqual(["close"]);
    const [closing] = closingOf(calls);
    expect(closing).toMatchObject({
      status: "aborted",
      roomId: "room-1",
      matchEndReason: "NEVER_STARTED",
    });
    expect(closing?.matchConfig.seed).toBe("s");
    expect(closing).not.toHaveProperty("matchStartedAt");
    expect(closing).not.toHaveProperty("matchDurationInMs");
  });

  // LA CONEXIÓN LA SABE LA SALA, y el grabador sólo la pregunta al cerrar. El asiento que nunca tuvo
  // socket —una máquina, el que no entró— no tiene nada que contar y sale sin la clave.
  it("el cierre lleva la conexión que le da la sala, y nada para el asiento sin socket", () => {
    const { history, calls } = build();
    const connection: SeatConnection = {
      rtt: { samples: 2, avgMs: 85, maxMs: 90, jitterMs: 3, lostProbes: 0 },
      events: [{ kind: "RECONNECTED", at: 7_000, roundNumber: 1, awayMs: 2_000 }],
    };
    history.trackConnections((playerId) => (playerId === "seat-1" ? connection : undefined));

    history.close(ENDING);

    const [closing] = closingOf(calls);
    expect(closing?.players[0]?.connection).toEqual(connection);
    expect(closing?.players[1]).not.toHaveProperty("connection");
  });

  it("sin trackConnections el cierre no cambia", () => {
    const { history, calls } = build();
    history.close(ENDING);

    for (const player of closingOf(calls)[0]?.players ?? [])
      expect(player).not.toHaveProperty("connection");
  });

  it("cierra una sola vez, y después de cerrar ya no abre", () => {
    const { history, calls } = build();
    history.close(ENDING);
    history.close({ ...ENDING, status: "aborted" });
    history.events([{ type: "ROUND_STARTED", roundNumber: 1 }]);

    expect(calls.filter((call) => call.verb === "close")).toHaveLength(1);
    expect(calls.filter((call) => call.verb === "open")).toHaveLength(0);
  });

  // QUIÉN SE FUE Y CÓMO es el otro eje del final. El reloj retira a los dos, pero al que tenía la
  // conexión caída no se lo saca por callar: se le cayó. Lo dice el árbol en el instante del retiro.
  it("distingue al que se fue, al que se le venció el turno y al que se le cayó la conexión", () => {
    const { history, calls, match, clockBox } = build();
    clockBox.now = 9_000;
    history.command("PLAYER", "ABANDON", { playerId: "seat-1" });
    const seat2 = match.players[1];
    if (seat2) seat2.connected = false;
    history.events([{ type: "ABANDON", playerId: "seat-2" }]);
    history.close(ENDING);

    const [closing] = closingOf(calls);
    expect(closing?.players.map((player) => player.exit?.reason)).toEqual(["LEFT", "DISCONNECTED"]);
    expect(closing?.players[0]?.exit).toEqual({ reason: "LEFT", at: 9_000, roundNumber: 0 });
  });

  it("el retiro del reloj a un jugador conectado es un turno vencido", () => {
    const { history, calls } = build();
    history.events([{ type: "ABANDON", playerId: "seat-2" }]);
    history.close(ENDING);

    expect(closingOf(calls)[0]?.players[1]?.exit?.reason).toBe("TIMEOUT");
  });

  // Un retiro que el registro nunca vio —antes de que se grabara nada— se fecha en el cierre.
  it("el que el árbol da por retirado sin que el registro lo viera irse, se fue", () => {
    const { history, calls, match, clockBox } = build();
    const seat1 = match.players[0];
    if (seat1) seat1.hasAbandoned = true;
    clockBox.now = 7_000;
    history.close(ENDING);

    expect(closingOf(calls)[0]?.players[0]?.exit).toEqual({
      reason: "LEFT",
      at: 7_000,
      roundNumber: 0,
    });
  });

  it("sigue cada oferta de aumento hasta cómo terminó", () => {
    const { history, calls, clockBox } = build();
    const at = (now: number) => {
      clockBox.now = now;
    };
    at(1_000);
    history.command("PLAYER", "PROPOSE_BET_MULTIPLIER", { playerId: "seat-1", level: 2 });
    at(2_000);
    history.command("PLAYER", "RESPOND_BET_MULTIPLIER", { playerId: "seat-2", accept: false });
    at(3_000);
    history.command("PLAYER", "PROPOSE_BET_MULTIPLIER", { playerId: "seat-2", level: 3 });
    at(4_000);
    history.events([{ type: "BET_MULTIPLIER_REJECTED", playerId: "seat-1" }]);
    at(5_000);
    history.command("PLAYER", "PROPOSE_BET_MULTIPLIER", { playerId: "seat-1", level: 2 });
    history.command("PLAYER", "RESPOND_BET_MULTIPLIER", { playerId: "seat-2", accept: true });
    // EL COBRO NO SALIÓ: el trato se deshizo, y la oferta tiene que decirlo.
    history.events([{ type: "MULTIPLIER_REVOKED", level: 2 }]);
    at(6_000);
    history.command("PLAYER", "PROPOSE_BET_MULTIPLIER", { playerId: "seat-1", level: 5 });
    history.command("PLAYER", "RESPOND_BET_MULTIPLIER", { playerId: "seat-2", accept: true });
    history.command("PLAYER", "PROPOSE_BET_MULTIPLIER", { playerId: "seat-2", level: 3 });
    history.close(ENDING);

    const proposals = closingOf(calls)[0]?.betMultiplier.proposals ?? [];
    expect(
      proposals.map((p) => [
        p.proposedBy,
        p.value,
        p.outcome,
        p.respondedBy,
        p.betMultiplierAttempt,
      ]),
    ).toEqual([
      ["seat-1", 2, "REJECTED", "seat-2", undefined],
      ["seat-2", 3, "EXPIRED", "seat-1", undefined],
      ["seat-1", 2, "UNCHARGED", "seat-2", 1],
      ["seat-1", 5, "ACCEPTED", "seat-2", 2],
      ["seat-2", 3, "UNANSWERED", undefined, undefined],
    ]);
    expect(proposals[0]).toMatchObject({ proposedAt: 1_000, resolvedAt: 2_000 });
  });
});
