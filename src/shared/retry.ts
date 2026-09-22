// Retrying with exponential backoff. It lives in `shared/` because it is genuinely PORTABLE, and
// because the two features that deliver effects outwards both use it and neither may import the
// other.
//
// What is shared is the LOOP and not a class: each outbox has its own register, its own idempotency
// key and its own notion of "it landed". Generalising past this, with only two cases, would be
// guessing.

import { sleep } from "./sleep";

export interface RetryPolicy {
  // How many attempts before giving up. Past that point the failure stops looking like a network
  // hiccup and needs a human; retrying further only hides the problem.
  readonly maxAttempts: number;
  // The wait BEFORE each attempt, doubling: with 500 it is 500ms, 1s, 2s. It exists so as not to
  // hammer a service that is already in trouble.
  readonly baseDelayMs: number;
}

export interface RetryOptions {
  // Stops without spending the remaining attempts when the error says retrying will change nothing:
  // a refusal from the other side is not the same as a timeout.
  readonly isFinal?: (error: unknown) => boolean;
  // To cut short during an ordered shutdown. Without it, a signal with deliveries in flight would
  // have to wait out every retry.
  readonly signal?: AbortSignal;
  // WHAT HAPPENED ON A FAILED ATTEMPT. Without it the intermediate error is dropped down there and
  // leaves no trace: a delivery that landed on the third attempt looks like one that landed on the
  // first, and the two failures — the signal that the other side is in trouble — do not exist.
  //
  // A CALLBACK and not a logger on purpose: a loop that knows how to log already knows too much.
  readonly onAttemptFailed?: (error: unknown, attempt: number, willRetry: boolean) => void;
}

/** @returns whether the operation landed. */
export async function withRetries(
  attempt: () => Promise<unknown>,
  policy: RetryPolicy,
  options: RetryOptions = {},
): Promise<boolean> {
  const { isFinal = () => false, signal, onAttemptFailed } = options;
  for (let i = 0; i < policy.maxAttempts; i++) {
    await sleep(policy.baseDelayMs * 2 ** i, signal);
    if (signal?.aborted) return false;
    try {
      await attempt();
      return true;
    } catch (e) {
      const final = isFinal(e);
      onAttemptFailed?.(e, i + 1, !final && i + 1 < policy.maxAttempts);
      if (final) return false;
    }
  }
  return false;
}
