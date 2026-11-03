import { monitorEventLoopDelay } from "node:perf_hooks";

// CUÁN TRABADO ESTÁ EL PROCESO, para juzgar una caída: un event loop atrasado contesta tarde a TODOS,
// y eso es lag nuestro aunque lo muestre el ping de un solo jugador. Es del PROCESO y no de la sala,
// así que hay uno solo, y CORRE DESDE QUE SE IMPORTA: la primera caída después de un arranque —justo
// cuando el proceso puede estar trabado— tiene que ver el atraso que ya hubo.
const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
// `unref`: medir no puede dejar vivo a un proceso que se está apagando.
setInterval(() => histogram.reset(), 10_000).unref();

/** El p99 del retraso del event loop en los últimos ~10 s, en ms. */
export function eventLoopP99Ms(): number {
  const p99 = histogram.percentile(99);
  return Number.isFinite(p99) ? Math.round(p99 / 1e6) : 0;
}
