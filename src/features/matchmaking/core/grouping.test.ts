import { describe, expect, it } from "vitest";
import { type GroupingTicket, formGroup } from "./grouping";

const NOW = 10_000;
const OPTIONS = { seats: 2, now: NOW, vetoBypassMs: 20_000, candidates: 12 };

// The tickets are declared by how long they have been waiting, which reads better than an epoch.
interface TestTicket extends GroupingTicket {
  readonly poolId: string;
  readonly request: { readonly kind: "CASUAL"; readonly gameModeId: string };
}

function waiting(playerId: string, waitedMs = 0, avoid: string[] = []): TestTicket {
  return {
    playerId,
    poolId: "mesa",
    request: { kind: "CASUAL", gameModeId: "mesa" },
    enqueuedAt: NOW - waitedMs,
    avoid,
  };
}

const ids = (group: readonly TestTicket[] | undefined) => group?.map((t) => t.playerId);

describe("formGroup: quiénes juegan juntos", () => {
  it("sin suficientes para llenar la mesa, no hay grupo", () => {
    expect(formGroup([waiting("u1")], OPTIONS)).toBeUndefined();
    expect(formGroup([], OPTIONS)).toBeUndefined();
  });

  it("junta a los que más esperaron", () => {
    const group = formGroup([waiting("nuevo", 1), waiting("viejo", 500)], OPTIONS);

    expect(ids(group)).toEqual(["viejo", "nuevo"]);
  });

  it("llena mesas de cuatro cuando la mesa es de cuatro", () => {
    const cola = ["u1", "u2", "u3", "u4", "u5"].map((id, i) => waiting(id, 100 - i));

    expect(ids(formGroup(cola, { ...OPTIONS, seats: 4 }))).toEqual(["u1", "u2", "u3", "u4"]);
  });

  // The list's order IS the team assignment: the room hands out teams by index, so `[a,b,c,d]` means
  // a+c against b+d. Two who queue together land consecutively, that is, on OPPOSING teams — the
  // opposite of what a pair of coordinated accounts would want.
  it("el orden separa a los que llegaron juntos en equipos opuestos", () => {
    const cola = [
      waiting("cómplice-a", 100),
      waiting("cómplice-b", 99),
      waiting("x", 98),
      waiting("y", 97),
    ];

    const group = formGroup(cola, { ...OPTIONS, seats: 4 });

    const equipoDe = (id: string) => (ids(group)?.indexOf(id) ?? -1) % 2;
    expect(equipoDe("cómplice-a")).not.toBe(equipoDe("cómplice-b"));
  });
});

describe("formGroup: el veto es una preferencia, nunca un bloqueo", () => {
  it("prefiere a quien no está vetado, aunque haya llegado después", () => {
    const cola = [waiting("u1", 500, ["vetado"]), waiting("vetado", 400), waiting("libre", 10)];

    expect(ids(formGroup(cola, OPTIONS))).toEqual(["u1", "libre"]);
  });

  it("el veto vale en las dos direcciones: basta con que uno de los dos lo tenga", () => {
    const cola = [waiting("u1", 500), waiting("u2", 400, ["u1"]), waiting("libre", 10)];

    expect(ids(formGroup(cola, OPTIONS))).toEqual(["u1", "libre"]);
  });

  it("mientras el vetado sea el único rival y el plazo no venza, se sigue esperando", () => {
    const cola = [waiting("u1", 5_000, ["u2"]), waiting("u2", 4_000)];

    expect(formGroup(cola, OPTIONS)).toBeUndefined();
  });

  // THE system's hard guarantee: a veto can delay up to the grace period, never prevent playing.
  // Without it, two players alone at a table and vetoed against each other never play.
  it("agotado el plazo, empareja igual: nadie queda colgado por el antifraude", () => {
    const cola = [waiting("u1", 21_000, ["u2"]), waiting("u2", 20_500)];

    expect(ids(formGroup(cola, OPTIONS))).toEqual(["u1", "u2"]);
  });

  // The grace period counts from whoever waited LONGEST and not from whoever waited least: someone
  // half an hour in does not restart their clock because a newcomer arrived.
  it("el plazo lo mide el que más esperó", () => {
    const cola = [waiting("paciente", 25_000, ["recién-llegado"]), waiting("recién-llegado", 100)];

    expect(ids(formGroup(cola, OPTIONS))).toEqual(["paciente", "recién-llegado"]);
  });

  // At a table of four the veto counts between ALL pairs and not only rivals: two accomplices as
  // partners are exactly the pattern being avoided.
  it("en mesas de cuatro, ninguna pareja del grupo puede estar vetada", () => {
    const cola = [
      waiting("u1", 500, ["u3"]),
      waiting("u2", 400),
      waiting("u3", 300),
      waiting("u4", 200),
      waiting("u5", 100),
    ];

    const group = formGroup(cola, { ...OPTIONS, seats: 4 });

    expect(ids(group)).toEqual(["u1", "u2", "u4", "u5"]);
  });
});
