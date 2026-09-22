import { MemoryLogger } from "@/shared/tests/memory-logger";
import { describe, expect, it, vi } from "vitest";
import type { CasualRoomOptions, DominoRoomOptions, Seat } from "../../transports/match-contract";
import { RematchCoordinator } from "../rematch";

// LA MITAD DE LA REVANCHA QUE HABLA CON EL MUNDO. Lo que se mide acá es lo que el motor no
// puede: las tres preguntas de la elegibilidad, y que la mesa nueva salga con la economía de la
// vieja y un eslabón más de cadena.

const TABLE: CasualRoomOptions = {
  mode: "CASUAL",
  gameModeId: "clasica-2p",
  seats: ["seat-1", "seat-2"],
  seed: "semilla-de-la-primera",
  pointsToWin: 100,
  entryFee: 125,
  prize: 250,
  rankingWeight: 1,
  isFreeRoom: false,
};

const build = (
  over: {
    canAfford?: boolean | ((playerId: string) => boolean);
    antifraud?: boolean | (() => Promise<boolean>);
    open?: () => Promise<readonly Seat[]>;
    maxRematchesPerChain?: number;
  } = {},
) => {
  const opened: DominoRoomOptions[] = [];
  const sent: { playerId: string; type: string; payload: unknown }[] = [];
  const closed = vi.fn();
  const log = new MemoryLogger();
  const coordinator = new RematchCoordinator({
    wallet: {
      canAfford: async ({ playerId }) =>
        typeof over.canAfford === "function" ? over.canAfford(playerId) : (over.canAfford ?? true),
    },
    antifraud: async () =>
      typeof over.antifraud === "function" ? await over.antifraud() : (over.antifraud ?? true),
    opener: {
      open: async (options) => {
        opened.push(options);
        if (over.open) return over.open();
        return options.seats.map((playerId) => ({
          playerId,
          reservation: { roomId: "sala-2", playerId },
        }));
      },
    },
    seedOf: () => "semilla-de-la-revancha",
    maxRematchesPerChain: () => over.maxRematchesPerChain ?? 1,
    log,
  });
  const door = { allow: vi.fn(), deny: vi.fn() };
  const sink = coordinator.sinkFor(
    TABLE,
    "match-1",
    door,
    (playerId, type, payload) => sent.push({ playerId, type, payload }),
    closed,
  );
  return { coordinator, door, sink, opened, sent, closed, log };
};

// Deja correr las promesas que el sink dispara: es síncrono a propósito —el motor lo es— y lo
// único que hace es arrancar el trabajo.
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("la elegibilidad", () => {
  it("deja jugar otra con saldo, sin veto y con la cadena en cero", async () => {
    expect(await build().coordinator.isEligible(TABLE, "match-1")).toBe(true);
  });

  // EL TOPE DE LA CADENA ES ANTI-ABUSO: sin él, dos cómplices se pasan la partida entre ellos
  // sin volver a pasar nunca por el emparejador, que es quien los separaría.
  it("no deja una segunda revancha en la misma cadena", async () => {
    const chained = { ...TABLE, rematchCount: 1 };

    expect(await build().coordinator.isEligible(chained, "match-2")).toBe(false);
  });

  // EL TOPE SALE DE LA CONFIG y no de una constante: subirlo en caliente deja jugar la revancha de
  // la revancha. Sin este `it`, un coordinador que ignorara su dependencia seguía verde con el 1.
  it("el tope es el de la config, no uno fijo", async () => {
    const chained = { ...TABLE, rematchCount: 1 };

    expect(
      await build({ maxRematchesPerChain: 2 }).coordinator.isEligible(chained, "match-2"),
    ).toBe(true);
  });

  it("el veto entre estos dos la apaga", async () => {
    expect(await build({ antifraud: false }).coordinator.isEligible(TABLE, "match-1")).toBe(false);
  });

  it("basta que UNO no tenga saldo", async () => {
    const onlyFirst = (playerId: string) => playerId === "seat-1";

    expect(await build({ canAfford: onlyFirst }).coordinator.isEligible(TABLE, "match-1")).toBe(
      false,
    );
  });

  // LA MESA GRATIS NI PREGUNTA, y no es un atajo: sin inscripción no hay saldo que alcance o no,
  // y preguntarlo sería una llamada de red por cada partida gratis que termina.
  it("la mesa gratis no consulta la billetera", async () => {
    const wallet = vi.fn(async () => true);
    const coordinator = new RematchCoordinator({
      wallet: { canAfford: wallet },
      antifraud: async () => true,
      opener: { open: async () => [] },
      seedOf: () => "s",
      maxRematchesPerChain: () => 1,
      log: new MemoryLogger(),
    });

    expect(await coordinator.isEligible({ ...TABLE, entryFee: 0 }, "match-1")).toBe(true);
    expect(wallet).not.toHaveBeenCalled();
  });

  // FALLA HACIA EL NO. El costo de equivocarse es asimétrico: negar una revancha legítima cuesta
  // una pantalla, permitir una que no se puede pagar abre una mesa que muere con una entrada
  // cobrada.
  it("un chequeo que revienta contesta que no, y lo deja escrito", async () => {
    const built = build({
      antifraud: () => Promise.reject(new Error("el backend no contesta")),
    });

    expect(await built.coordinator.isEligible(TABLE, "match-1")).toBe(false);
    expect(built.log.at_("error")).toHaveLength(1);
  });
});

describe("la compuerta", () => {
  it("se abre con el veredicto cuando pueden", async () => {
    const { sink, door } = build();

    sink([{ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }]);
    await settle();

    expect(door.allow).toHaveBeenCalledOnce();
    expect(door.deny).not.toHaveBeenCalled();
  });

  it("se niega cuando no pueden", async () => {
    const { sink, door } = build({ canAfford: false });

    sink([{ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }]);
    await settle();

    expect(door.deny).toHaveBeenCalledOnce();
  });

  // EL TORNEO NO TIENE COORDINADOR: no se le pregunta a la billetera por una mesa que no ofrece
  // revancha, y la compuerta queda en su default, que es cerrada.
  it("una mesa de torneo no pregunta nada", async () => {
    const { coordinator, door } = build();
    const sink = coordinator.sinkFor(
      {
        mode: "TOURNAMENT",
        tournamentId: "t1",
        seats: [],
        seed: "s",
        pointsToWin: 10,
        pointsPerLoss: 1,
      },
      "match-1",
      door,
      () => {},
      () => {},
    );

    sink([{ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }]);
    await settle();

    expect(door.allow).not.toHaveBeenCalled();
    expect(door.deny).not.toHaveBeenCalled();
  });
});

describe("abrir la mesa nueva", () => {
  const accepted = { type: "REMATCH_ACCEPTED", playerIds: ["seat-1", "seat-2"] } as const;

  it("conserva el modo y la economía, cambia la semilla y suma un eslabón", async () => {
    const { sink, opened } = build();

    sink([accepted]);
    await settle();

    expect(opened).toEqual([
      {
        ...TABLE,
        seed: "semilla-de-la-revancha",
        rematchCount: 1,
        // LA CADENA LA BAUTIZA LA PRIMERA MESA: sin esto cada revancha empezaría una cadena
        // nueva y el tope de la anterior no limitaría nada.
        rematchChainId: "semilla-de-la-primera",
      },
    ]);
  });

  it("la segunda mesa hereda la cadena de la primera en vez de rebautizarla", async () => {
    const { coordinator, opened } = build();
    const sink = coordinator.sinkFor(
      { ...TABLE, rematchCount: 0, rematchChainId: "cadena-original" },
      "match-1",
      { allow: vi.fn(), deny: vi.fn() },
      () => {},
      () => {},
    );

    sink([accepted]);
    await settle();

    expect(opened[0]).toMatchObject({ rematchChainId: "cadena-original" });
  });

  // ⚠ CADA RESERVA A SU DUEÑO Y NUNCA POR BROADCAST: quien tenga la ajena puede consumirla y
  // sentarse en su lugar, dejándolo afuera de una partida que ya pagó.
  it("le manda a cada uno su reserva, y sólo la suya", async () => {
    const { sink, sent } = build();

    sink([accepted]);
    await settle();

    expect(sent).toEqual([
      {
        playerId: "seat-1",
        type: "REMATCH_SEAT",
        payload: { roomId: "sala-2", playerId: "seat-1" },
      },
      {
        playerId: "seat-2",
        type: "REMATCH_SEAT",
        payload: { roomId: "sala-2", playerId: "seat-2" },
      },
    ]);
  });

  // Si la sala nueva no abre no hay nada que deshacer —la vieja ya terminó y no se movió un
  // centavo—, pero sí hay a quién sacar de la pantalla: el que aceptó se quedaría mirando el
  // traspaso hasta que venza.
  it("una apertura que falla cierra la mesa y lo deja escrito", async () => {
    const built = build({ open: () => Promise.reject(new Error("no hay sala")) });

    built.sink([accepted]);
    await settle();

    expect(built.closed).toHaveBeenCalledOnce();
    expect(built.sent).toEqual([]);
    expect(built.log.at_("error")).toHaveLength(1);
  });
});
