/**
 * Waiting a while, and being able to stop waiting.
 *
 * Two properties a bare `setTimeout` does not have and that matter in this server:
 *
 *  - **It does not hold the process.** Without `unref()`, a sleeping timer keeps
 *    Node from exiting until it fires, so a shutdown with pending waits would be
 *    delayed by all of them. It is optional because fake timers do not implement
 *    it.
 *  - **It can be cut short.** An ordered shutdown, or a player cancelling their
 *    search, has no reason to wait for the clock. Aborting RESOLVES — it does not
 *    reject — so the caller checks `signal.aborted` and decides, instead of having
 *    to wrap every wait in a `try`.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer: { unref?: () => void } = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer as unknown as Parameters<typeof clearTimeout>[0]);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer.unref?.();
  });
}
