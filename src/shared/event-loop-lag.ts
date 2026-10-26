import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";

// CUÁN TRABADO ESTÁ EL PROCESO, para juzgar una caída: un event loop atrasado contesta tarde a TODOS,
// y eso es lag nuestro aunque lo muestre el ping de un solo jugador. Es del PROCESO y no de la sala,
// así que hay uno solo; arranca la primera vez que alguien pregunta.
let histogram: IntervalHistogram | undefined;

/** El p99 del retraso del event loop en los últimos ~10 s, en ms. */
export function eventLoopP99Ms(): number {
  if (!histogram) {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    const current = histogram;
    // `unref`: medir no puede dejar vivo a un proceso que se está apagando.
    setInterval(() => current.reset(), 10_000).unref();
  }
  const p99 = histogram.percentile(99);
  return Number.isFinite(p99) ? Math.round(p99 / 1e6) : 0;
}
