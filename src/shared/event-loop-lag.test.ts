import { describe, expect, it } from "vitest";
import { eventLoopP99Ms } from "./event-loop-lag";

// EL MEDIDOR CORRE DESDE QUE SE IMPORTA, no desde la primera pregunta: la primera caída después de un
// arranque —justo cuando el proceso puede estar trabado— tiene que ver el atraso que ya hubo.
describe("eventLoopP99Ms", () => {
  it("ve un atraso que pasó antes de la primera pregunta", async () => {
    const until = Date.now() + 120;
    while (Date.now() < until) {
      // Traba el event loop a propósito.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Antes arrancaba en la primera pregunta y esta daba 0. El p99 no tiene por qué llegar a los 120 ms
    // de una sola traba entre muchas muestras de 20 ms: lo que se mide es que la vio.
    expect(eventLoopP99Ms()).toBeGreaterThan(0);
  });
});
