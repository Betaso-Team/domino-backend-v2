// Putting a deadline on someone else's promise. Portable like `retry`: it knows nothing of truco or
// money.
//
// It exists because "in flight" has to be BOUNDED. A service that does not answer — neither well nor
// badly — leaves an operation hanging forever, and whoever depends on knowing whether it landed waits
// on an outcome that never arrives. A deadline turns that silence into an answer.

export class DeadlineExceededError extends Error {
  constructor(readonly ms: number) {
    super(`la operación excedió su plazo de ${ms}ms`);
    this.name = "DeadlineExceededError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // `unref()` for the same reason as in `retry`: a pending deadline must not hold the process open.
    const timer: { unref?: () => void } = setTimeout(
      () => reject(new DeadlineExceededError(ms)),
      ms,
    );
    timer.unref?.();
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timer as unknown as Parameters<typeof clearTimeout>[0]));
  });
}
