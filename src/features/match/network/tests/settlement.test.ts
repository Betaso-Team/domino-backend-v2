import { describe, expect, it } from "vitest";
import { createMatchState } from "../../core/engine/genesis";
import { replayConfigOf } from "../../transports/match-contract";
import type { AbortReason } from "../events";
import { settlementOf } from "../settlement";

// EL SNAPSHOT DE LA MESA, Y SE ARMA CON `replayConfigOf` Y NO CON `configOf`. Lo que `settlementOf`
// recibe es la mesa YA CONGELADA —asientos numerados, dinero adentro—, que es exactamente lo que
// esta función valida; `configOf` pide además el `GameMode` resuelto, o sea que armar estas mesas
// con él obligaría a inventar un catálogo para medir una proyección que no lo consulta.
//
// ⚠ Y HAY UN SEGUNDO MOTIVO, que es el que decide: desde la Tarea 10 `configOf` RECHAZA el 4P, así
// que la mesa de cuatro de más abajo —la que mide las dos guardas más caras del archivo— no se
// podría ni escribir con él. La asimetría es deliberada y está argumentada en `match-contract.ts`:
// se prohíbe que una mesa de cuatro NAZCA, no que una ya grabada se pueda rebobinar y auditar. Y
// auditarla es justo lo que hace falta el día que una quede con la plata trabada.
const seatsOf = (participants: readonly Record<string, string>[]) =>
  participants.map((participant, index) => ({ ...participant, playerId: `seat-${index + 1}` }));

const options = {
  matchId: "money-1",
  gameModeId: "classic-2p",
  seats: seatsOf([
    { userId: "ada", displayName: "Ada", currency: "VES" },
    { userId: "lin", displayName: "Lin", currency: "USD" },
  ]),
  seed: "money-seed",
  pointsToWin: 100,
  teamAssignment: "SEAT_ORDER",
  isDealWindowEnabled: true,
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFee: 125,
  prize: 250,
} as const;

// La mesa de CUATRO, que el motor ya no sienta y el replay sí reconstruye. Sirve para dos cosas
// distintas: el reembolso de cuatro entradas —que sí se paga— y el desajuste de forma contra un
// estado de dos, que es la única manera que hay hoy de cruzar dos mesas distintas y notarlo.
const fourSeatOptions = {
  ...options,
  matchId: "money-4p",
  gameModeId: "classic-4p",
  seats: seatsOf([
    { userId: "u1", displayName: "Ada", currency: "VES" },
    { userId: "u2", displayName: "Lin", currency: "VES" },
    { userId: "u3", displayName: "Rex", currency: "USD" },
    { userId: "u4", displayName: "Zoe", currency: "COP" },
  ]),
} as const;

const config = replayConfigOf(options);
const matchOf = () => createMatchState(config);

// Las claves van como LITERAL y no recalculadas con el mismo `JSON.stringify` del código:
// recalcularlas mediría que dos expresiones idénticas dan lo mismo. Escritas a mano, pinean
// el FORMATO —que es lo que el pagador va a guardar como única defensa contra el pago doble—
// y se ponen rojas si alguien le cambia el orden o el separador.
const rewardKey = '["money-1","REWARD","ada"]';
const refundKeys = ['["money-1","REFUND","ada"]', '["money-1","REFUND","lin"]'];

const refundOfMoney1 = {
  matchId: "money-1",
  rateId: options.rateId,
  kind: "REFUND",
  entries: [
    { userId: "ada", currency: "VES", amount: 125, idempotencyKey: refundKeys[0] },
    { userId: "lin", currency: "USD", amount: 125, idempotencyKey: refundKeys[1] },
  ],
};

const abortReasons: readonly AbortReason[] = ["NEVER_STARTED", "NEVER_PLAYED", "INTERRUPTED"];

describe("settlementOf", () => {
  it("premia al ganador con su identidad y la moneda cobrada", () => {
    const match = matchOf();
    const winnerTeamId = match.players[0]?.teamId as "A" | "B";
    expect(
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" }, match, config),
    ).toEqual({
      matchId: "money-1",
      rateId: options.rateId,
      kind: "REWARD",
      entries: [{ userId: "ada", currency: "VES", amount: 250, idempotencyKey: rewardKey }],
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
    const fourSeatConfig = replayConfigOf(fourSeatOptions);
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
          userId: "u1",
          currency: "VES",
          amount: 125,
          idempotencyKey: '["money-4p","REFUND","u1"]',
        },
        {
          userId: "u2",
          currency: "VES",
          amount: 125,
          idempotencyKey: '["money-4p","REFUND","u2"]',
        },
        {
          userId: "u3",
          currency: "USD",
          amount: 125,
          idempotencyKey: '["money-4p","REFUND","u3"]',
        },
        {
          userId: "u4",
          currency: "COP",
          amount: 125,
          idempotencyKey: '["money-4p","REFUND","u4"]',
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

  // LA OTRA MITAD DE LA GUARDA, y es la que puede pasar de verdad: una mesa de cuatro grabada se
  // reconstruye sin objeción, así que dos ganadores del mismo equipo siguen siendo alcanzables.
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
    const fourSeatConfig = replayConfigOf(fourSeatOptions);
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
  // congelada de cada asiento las distingue. Sin comparar el `userId`, esto pagaba los 250 a
  // alguien de la otra mesa con una instrucción impecable.
  it("rechaza otro estado del mismo tamaño y nombra la identidad que no coincide", () => {
    const otherTable = replayConfigOf({
      ...options,
      matchId: "money-2",
      seats: seatsOf([
        { userId: "rex", displayName: "Rex", currency: "USD" },
        { userId: "zoe", displayName: "Zoe", currency: "COP" },
      ]),
    });
    expect(() =>
      settlementOf(
        { type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" },
        createMatchState(otherTable),
        config,
      ),
    ).toThrow(/seat-1 es rex en el estado y ada en el snapshot/);
  });

  // EL DECIMAL LLEGA ENTERO HASTA LA INSTRUCCIÓN, y es la mitad de esta tarea que un
  // renombre no alcanza a probar. Los montos son UC COMPLETAS: una mesa de `1.5` reembolsa
  // `1.5` y paga `2.75`, sin un `* 100` en el medio. Los números van como LITERAL y no
  // leídos de `config.entryFee`: recalcularlos con el mismo campo que la implementación
  // copia mediría que dos lecturas del mismo dato coinciden, y seguiría verde el día que
  // alguien reintroduzca la escala en los dos lados a la vez.
  it("proyecta las UC decimales tal cual, sin escalarlas", () => {
    const decimalTable = replayConfigOf({
      ...options,
      matchId: "money-dec",
      seats: seatsOf([
        { userId: "u1", displayName: "Ada", currency: "VES" },
        { userId: "u2", displayName: "Lin", currency: "USD" },
      ]),
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
        { userId: "u1", currency: "VES", amount: 1.5 },
        { userId: "u2", currency: "USD", amount: 1.5 },
      ],
    });
    expect(
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" }, match, decimalTable),
    ).toMatchObject({ kind: "REWARD", entries: [{ amount: 2.75 }] });
  });

  // La mesa GRATIS emite igual, con sus entradas en cero: es la decisión escrita en
  // `settlement.ts`, y sin test alguien la "optimiza" y deja a una liquidación sin rastro.
  it("emite el reembolso de una mesa gratis con las entradas en cero", () => {
    const free = replayConfigOf({ ...options, matchId: "money-free", entryFee: 0 });
    const result = settlementOf(
      { type: "MATCH_ABORTED", reason: "NEVER_STARTED" },
      createMatchState(free),
      free,
    );
    expect(result?.kind).toBe("REFUND");
    expect(result?.entries.map(({ amount }) => amount)).toEqual([0, 0]);
  });
});
