import { describe, expect, it, vi } from "vitest";
import { sweepStaleRooms } from "./stale-rooms";

describe("sweepStaleRooms", () => {
  it("chequea una vez a cada proceso dueño de salas, menos al propio", async () => {
    const healthCheckProcessId = vi.fn(async (id: string) => id !== "muerto");
    const checked = await sweepStaleRooms({
      processId: "yo",
      driver: {
        query: async () => [
          { processId: "yo" },
          { processId: "muerto" },
          { processId: "muerto" },
          { processId: "vivo" },
        ],
      },
      healthCheckProcessId,
    });

    expect(healthCheckProcessId.mock.calls.map(([id]) => id).sort()).toEqual(["muerto", "vivo"]);
    expect(checked).toEqual(["muerto", "vivo"]);
  });

  it("sin salas ajenas no pregunta nada", async () => {
    const healthCheckProcessId = vi.fn(async () => true);
    await sweepStaleRooms({
      processId: "yo",
      driver: { query: async () => [{ processId: "yo" }] },
      healthCheckProcessId,
    });

    expect(healthCheckProcessId).not.toHaveBeenCalled();
  });
});
