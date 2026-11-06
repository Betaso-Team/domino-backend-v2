import { describe, expect, it, vi } from "vitest";
import { ColyseusMatchGateway, type SeatBackMatchMaker } from "./gateway";

// LA VUELTA AL ASIENTO CONTRA UN MATCHMAKER DE MENTIRA. Lo que se mide es la decisión que sigue a una
// reserva fallida —«la sala ya no existe» contra «no sé» o «existe»—, que con el de verdad pide un
// proceso muerto. El camino entero contra Colyseus está en `orchestrator-tables.e2e.test.ts`.
function matchMakerWith(over: Partial<SeatBackMatchMaker>): SeatBackMatchMaker {
  return {
    joinById: async () => ({ sessionId: "s-1" }),
    query: async () => [{ roomId: "room-1" }],
    ...over,
  };
}

// El mensaje del `SeatReservationError` de Colyseus, que la superficie de `@colyseus/core` no exporta.
// Se compara por identidad: lo que se relanza tiene que ser el error ORIGINAL, no uno nuevo.
const reservationError = new Error("process p-9 is not available.");
const deadProcess = () => Promise.reject(reservationError);

describe("ColyseusMatchGateway.seatBack", () => {
  it("devuelve la reserva cuando la sala la da", async () => {
    const gateway = new ColyseusMatchGateway(matchMakerWith({}));
    expect(await gateway.seatBack("room-1")).toEqual({ sessionId: "s-1" });
  });

  // T-04: la sala de un proceso muerto no falla con «no existe» sino con `SeatReservationError`, y el
  // chequeo de salud que Colyseus hizo en el medio ya la sacó del registro de salas.
  it("con CUALQUIER fallo de la reserva y la sala ya fuera del registro, contesta que no hay mesa", async () => {
    const query = vi.fn(async () => []);
    const gateway = new ColyseusMatchGateway(matchMakerWith({ joinById: deadProcess, query }));

    expect(await gateway.seatBack("room-1")).toBeUndefined();
    expect(query).toHaveBeenCalledWith({ roomId: "room-1" });
  });

  it("si la sala sigue en el registro, relanza el error de la reserva", async () => {
    const gateway = new ColyseusMatchGateway(matchMakerWith({ joinById: deadProcess }));
    await expect(gateway.seatBack("room-1")).rejects.toBe(reservationError);
  });

  // «No sé» no es «no existe»: contestar 404 por una sala viva le abriría al jugador una segunda mesa.
  it("si la pregunta falla, relanza el error de la reserva", async () => {
    const gateway = new ColyseusMatchGateway(
      matchMakerWith({
        joinById: deadProcess,
        query: () => Promise.reject(new Error("redis caído")),
      }),
    );
    await expect(gateway.seatBack("room-1")).rejects.toBe(reservationError);
  });

  it("si la pregunta no contesta a tiempo, relanza el error de la reserva", async () => {
    const gateway = new ColyseusMatchGateway(
      matchMakerWith({ joinById: deadProcess, query: () => new Promise(() => {}) }),
      5,
    );
    await expect(gateway.seatBack("room-1")).rejects.toBe(reservationError);
  });
});

describe("ColyseusMatchGateway.isGone", () => {
  it("es true solo si el registro de salas no la tiene", async () => {
    expect(
      await new ColyseusMatchGateway(matchMakerWith({ query: async () => [] })).isGone("r"),
    ).toBe(true);
    expect(await new ColyseusMatchGateway(matchMakerWith({})).isGone("r")).toBe(false);
  });

  it("es false cuando la pregunta falla o no contesta a tiempo", async () => {
    const failing = matchMakerWith({ query: () => Promise.reject(new Error("redis caído")) });
    const silent = matchMakerWith({ query: () => new Promise(() => {}) });
    expect(await new ColyseusMatchGateway(failing).isGone("r")).toBe(false);
    expect(await new ColyseusMatchGateway(silent, 5).isGone("r")).toBe(false);
  });
});
