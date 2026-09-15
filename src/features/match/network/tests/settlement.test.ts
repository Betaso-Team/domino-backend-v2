import { describe, expect, it } from "vitest";
import { createMatchState } from "../../core/engine/genesis.js";
import { configOf } from "../../transports/match-contract.js";
import type { AbortReason } from "../events.js";
import { settlementOf } from "../settlement.js";

const options = {
  mode: "CASUAL",
  matchId: "money-1",
  gameModeId: "classic-2p",
  participants: [
    { platformId: "betaso", userUuid: "same", displayName: "Ada", currency: "VES" },
    { platformId: "partner", userUuid: "same", displayName: "Lin", currency: "USD" },
  ],
  seed: "money-seed",
  pointsToWin: 100,
  teamAssignment: "SEAT_ORDER",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFee: 125,
  prize: 250,
} as const;

// La mesa de CUATRO, que `configOf` acepta sin objeción. Sirve para dos cosas distintas: el
// reembolso de cuatro entradas —que sí se paga— y el desajuste de forma contra un estado de
// dos, que es la única manera que hay hoy de cruzar dos mesas distintas y notarlo.
const fourSeatOptions = {
  ...options,
  matchId: "money-4p",
  gameModeId: "classic-4p",
  participants: [
    { platformId: "betaso", userUuid: "u1", displayName: "Ada", currency: "VES" },
    { platformId: "betaso", userUuid: "u2", displayName: "Lin", currency: "VES" },
    { platformId: "partner", userUuid: "u3", displayName: "Rex", currency: "USD" },
    { platformId: "partner", userUuid: "u4", displayName: "Zoe", currency: "COP" },
  ],
} as const;

const config = configOf(options);
const matchOf = () => createMatchState(config);

// Las claves van como LITERAL y no recalculadas con el mismo `JSON.stringify` del código:
// recalcularlas mediría que dos expresiones idénticas dan lo mismo. Escritas a mano, pinean
// el FORMATO —que es lo que el pagador va a guardar como única defensa contra el pago doble—
// y se ponen rojas si alguien le cambia el orden o el separador.
const rewardKey = '["money-1","REWARD","betaso","same"]';
const refundKeys = [
  '["money-1","REFUND","betaso","same"]',
  '["money-1","REFUND","partner","same"]',
];

const refundOfMoney1 = {
  matchId: "money-1",
  rateId: options.rateId,
  kind: "REFUND",
  entries: [
    {
      platformId: "betaso",
      userUuid: "same",
      currency: "VES",
      amount: 125,
      idempotencyKey: refundKeys[0],
    },
    {
      platformId: "partner",
      userUuid: "same",
      currency: "USD",
      amount: 125,
      idempotencyKey: refundKeys[1],
    },
  ],
};

const abortReasons: readonly AbortReason[] = ["NEVER_STARTED", "NEVER_PLAYED", "INTERRUPTED"];

describe("settlementOf", () => {
  it("premia al ganador con su pareja y la moneda cobrada", () => {
    const match = matchOf();
    const winnerTeamId = match.players[0]?.teamId as "A" | "B";
    expect(
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" }, match, config),
    ).toEqual({
      matchId: "money-1",
      rateId: options.rateId,
      kind: "REWARD",
      entries: [
        {
          platformId: "betaso",
          userUuid: "same",
          currency: "VES",
          amount: 250,
          idempotencyKey: rewardKey,
        },
      ],
    });
  });

  // LOS TRES MOTIVOS REEMBOLSAN IGUAL, y sin esta vuelta el contrato solo vivía en un
  // comentario: quien agregue un `if (reason === "NEVER_STARTED") return undefined` —que
  // suena razonable, "esa mesa nunca arrancó"— deja la suite verde y le saca el reembolso a
  // una mesa cuya inscripción YA se cobró. La igualdad es completa, además, porque con
  // `objectContaining` de tres campos el `kind` del reembolso podía ser `"REWARD"` adentro
  // de la clave sin que nadie lo viera — y ahí la clave del reembolso del ganador es
  // idéntica a la de su premio, que es justo la colisión que la serialización evita.
  it.each(abortReasons)(
    "reembolsa a todos la inscripción, sea cual sea el motivo (%s)",
    (reason) => {
      expect(settlementOf({ type: "MATCH_ABORTED", reason }, matchOf(), config)).toEqual(
        refundOfMoney1,
      );
    },
  );

  it("reembolsa las cuatro entradas de una mesa de cuatro, cada una en su moneda", () => {
    const fourSeatConfig = configOf(fourSeatOptions);
    const result = settlementOf(
      { type: "MATCH_ABORTED", reason: "INTERRUPTED" },
      createMatchState(fourSeatConfig),
      fourSeatConfig,
    );
    expect(result).toEqual({
      matchId: "money-4p",
      rateId: options.rateId,
      kind: "REFUND",
      entries: [
        {
          platformId: "betaso",
          userUuid: "u1",
          currency: "VES",
          amount: 125,
          idempotencyKey: '["money-4p","REFUND","betaso","u1"]',
        },
        {
          platformId: "betaso",
          userUuid: "u2",
          currency: "VES",
          amount: 125,
          idempotencyKey: '["money-4p","REFUND","betaso","u2"]',
        },
        {
          platformId: "partner",
          userUuid: "u3",
          currency: "USD",
          amount: 125,
          idempotencyKey: '["money-4p","REFUND","partner","u3"]',
        },
        {
          platformId: "partner",
          userUuid: "u4",
          currency: "COP",
          amount: 125,
          idempotencyKey: '["money-4p","REFUND","partner","u4"]',
        },
      ],
    });
  });

  it("no proyecta los eventos que no son un desenlace", () => {
    const match = matchOf();
    expect(
      settlementOf({ type: "PLAYER_DISCONNECTED", playerId: "seat-1" }, match, config),
    ).toBeUndefined();
    expect(
      settlementOf({ type: "PLAYER_RECONNECTED", playerId: "seat-1" }, match, config),
    ).toBeUndefined();
    expect(settlementOf({ type: "DEADLINE_EXPIRED", kind: "TURN" }, match, config)).toBeUndefined();
  });

  it("rechaza un veredicto sin ganadores", () => {
    const match = matchOf();
    for (const player of match.players) player.teamId = "B";
    expect(() =>
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }, match, config),
    ).toThrow(/exactamente un ganador, recibió 0/);
  });

  // LA OTRA MITAD DE LA GUARDA, y es la que puede pasar de verdad: `configOf` acepta cuatro
  // participantes, así que una mesa con dos ganadores del mismo equipo es alcanzable hoy.
  // Sin esta aserción el guard podía ser `=== 0` y la suite seguía verde — pagando el premio
  // ENTERO a cada uno de los dos, o sea el doble de lo que la mesa cobró.
  it("rechaza varios ganadores en vez de pagarle el premio entero a cada uno", () => {
    const match = matchOf();
    for (const player of match.players) player.teamId = "A";
    expect(() =>
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }, match, config),
    ).toThrow(/exactamente un ganador, recibió 2/);
  });

  // EL FALLO QUE NO HACE RUIDO. Los `playerId` son posicionales, así que `seat-1` existe en
  // las dos mesas: sin la guarda esto NO daría cero ni dos ganadores —daría exactamente uno—
  // y emitiría una instrucción impecable, con el `matchId` y el `rateId` de la mesa de
  // cuatro, pagándole el premio a alguien que no jugó esta partida. Y el error tiene que
  // nombrar el desajuste: «recibió 0 ganadores» manda a soporte a auditar un veredicto sano.
  it("rechaza un estado que no es de la mesa del snapshot, y lo dice", () => {
    const twoSeatMatch = matchOf();
    const fourSeatConfig = configOf(fourSeatOptions);
    expect(() =>
      settlementOf(
        { type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" },
        twoSeatMatch,
        fourSeatConfig,
      ),
    ).toThrow(/no son de la misma mesa money-4p: 2 jugadores contra 4 asientos/);
    expect(() =>
      settlementOf({ type: "MATCH_ABORTED", reason: "INTERRUPTED" }, twoSeatMatch, fourSeatConfig),
    ).toThrow(/no son de la misma mesa/);
  });

  // EL MISMO FALLO PERO ENTRE DOS MESAS DEL MISMO TAMAÑO, que es el caso realista: dos 2P
  // tienen los mismos `seat-1`/`seat-2`, así que la forma coincide y solo la identidad
  // congelada de cada asiento las distingue. Sin comparar la pareja, esto pagaba los 250 a
  // alguien de la otra mesa con una instrucción impecable.
  it("rechaza otro estado del mismo tamaño y nombra la identidad que no coincide", () => {
    const otherTable = configOf({
      ...options,
      matchId: "money-2",
      participants: [
        { platformId: "betaso", userUuid: "ada", displayName: "Ada", currency: "VES" },
        { platformId: "partner", userUuid: "rex", displayName: "Rex", currency: "USD" },
      ],
    });
    expect(() =>
      settlementOf(
        { type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" },
        createMatchState(otherTable),
        config,
      ),
    ).toThrow(/seat-1 es \["betaso","ada"\] en el estado y \["betaso","same"\] en el snapshot/);
  });

  // EL DECIMAL LLEGA ENTERO HASTA LA INSTRUCCIÓN, y es la mitad de esta tarea que un
  // renombre no alcanza a probar. Los montos son UC COMPLETAS: una mesa de `1.5` reembolsa
  // `1.5` y paga `2.75`, sin un `* 100` en el medio. Los números van como LITERAL y no
  // leídos de `config.entryFee`: recalcularlos con el mismo campo que la implementación
  // copia mediría que dos lecturas del mismo dato coinciden, y seguiría verde el día que
  // alguien reintroduzca la escala en los dos lados a la vez.
  it("proyecta las UC decimales tal cual, sin escalarlas", () => {
    const decimalTable = configOf({
      ...options,
      matchId: "money-dec",
      participants: [
        { platformId: "betaso", userUuid: "u1", displayName: "Ada", currency: "VES" },
        { platformId: "partner", userUuid: "u2", displayName: "Lin", currency: "USD" },
      ],
      entryFee: 1.5,
      prize: 2.75,
    });
    const match = createMatchState(decimalTable);
    const winnerTeamId = match.players[0]?.teamId as "A" | "B";

    expect(
      settlementOf({ type: "MATCH_ABORTED", reason: "INTERRUPTED" }, match, decimalTable),
    ).toMatchObject({
      kind: "REFUND",
      entries: [
        { platformId: "betaso", userUuid: "u1", currency: "VES", amount: 1.5 },
        { platformId: "partner", userUuid: "u2", currency: "USD", amount: 1.5 },
      ],
    });
    expect(
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" }, match, decimalTable),
    ).toMatchObject({ kind: "REWARD", entries: [{ amount: 2.75 }] });
  });

  // La mesa GRATIS emite igual, con sus entradas en cero: es la decisión escrita en
  // `settlement.ts`, y sin test alguien la "optimiza" y deja a una liquidación sin rastro.
  it("emite el reembolso de una mesa gratis con las entradas en cero", () => {
    const free = configOf({ ...options, matchId: "money-free", entryFee: 0 });
    const result = settlementOf(
      { type: "MATCH_ABORTED", reason: "NEVER_STARTED" },
      createMatchState(free),
      free,
    );
    expect(result?.kind).toBe("REFUND");
    expect(result?.entries.map(({ amount }) => amount)).toEqual([0, 0]);
  });
});
