import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

// THE CAUSE IN PROGRESS, so our logs can be crossed with the main backend's.
//
// There are TWO axes and not one: `matchId` answers "which match?" and lives ten minutes; the trace
// answers "which CAUSE?" — this admission, this prize delivery, this request — and lives as long as
// the chain. Putting everything under one trace per match ruins both questions: a ten-minute trace
// with three hundred spans is not a trace.
//
// **It travels through `AsyncLocalStorage` and not as a parameter**, and that is the whole design
// decision. The alternative — a `ctx` in every signature — would cost EVERY port of the ring one
// parameter to solve an observability problem. Here it is opened at three borders and read in two
// places; in between it is never mentioned.
//
// The wire format is W3C Trace Context and not one of ours: it is what any framework can propagate
// with a middleware, and the day there are real traces the identifier is already in place.

export interface Trace {
  /** 32 hex characters. The one both services share, and the one that goes to the log. */
  readonly traceId: string;
  /**
   * 16 hex characters: THIS process's span within that cause. It is not logged —
   * the `traceId` is what joins the two halves — but it does travel, because it is
   * what the other side records as its parent.
   */
  readonly spanId: string;
}

const storage = new AsyncLocalStorage<Trace>();

/** The cause in progress, or `undefined` if there is none. */
export function currentTrace(): Trace | undefined {
  return storage.getStore();
}

/**
 * Runs `fn` INSIDE a cause. Whatever `fn` starts inherits it, `await`s included,
 * which is why wrapping the call is enough and nothing is propagated by hand.
 */
export function withTrace<T>(trace: Trace, fn: () => T): T {
  return storage.run(trace, fn);
}

/**
 * Runs `fn` WITH NO CAUSE at all, even if one is in progress. It exists because of
 * a leak only visible when measured: `AsyncLocalStorage` gives a `setInterval`
 * callback the cause that was live when the interval was CREATED, and Colyseus
 * creates the room clock's interval inside `createRoom` — that is, inside the
 * cause that formed the match. Without this, every deadline over the next ten
 * minutes inherits the matchmaking `traceId`: measured, 91 events of one match
 * under a single cause, which is exactly the ten-minute trace this file says
 * cannot exist.
 */
export function withoutTrace<T>(fn: () => T): T {
  return storage.exit(fn);
}

/**
 * A new cause. Opened by the borders that do not receive one from outside: a
 * player's admission, a prize delivery, the forming of a match.
 */
export function newTrace(): Trace {
  return { traceId: hex(16), spanId: hex(8) };
}

/**
 * The header that goes on the wire. `01` is the "sampled" flag: there is no
 * sampling here, everything that leaves is recorded, and saying otherwise would
 * have the other side drop half of it.
 */
export function traceparentOf(trace: Trace): string {
  return `00-${trace.traceId}-${trace.spanId}-01`;
}

/**
 * The cause coming from outside, if it comes and if it is valid. A malformed
 * header is IGNORED rather than rejecting the request: what is at stake is being
 * able to cross two logs, not the correctness of anything.
 *
 * `x-request-id` is accepted as a fallback, for a service that does not speak W3C
 * yet. It has to carry 32 hex characters to serve as a `traceId`; anything else
 * cannot be represented in a `traceparent`, and dragging along an identifier we
 * cannot re-emit would be worse than starting a new one — the link would break
 * silently at the next hop.
 */
export function traceFrom(headers: IncomingHeaders): Trace {
  const parsed = parseTraceparent(header(headers, "traceparent"));
  if (parsed) return parsed;

  const requestId = header(headers, "x-request-id");
  if (requestId && ID_32.test(requestId))
    return { traceId: requestId.toLowerCase(), spanId: hex(8) };

  return newTrace();
}

/** What we need of an incoming request and nothing more, so this does not depend on Express. */
export type IncomingHeaders = Record<string, string | string[] | undefined>;

const ID_32 = /^[0-9a-f]{32}$/i;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;

// The incoming `traceId` is the one CONTINUED; the span, on the other hand, is ours: the header's
// belongs to whoever called us, and reusing it would claim their span and ours are the same.
function parseTraceparent(value: string | undefined): Trace | undefined {
  const match = value === undefined ? null : TRACEPARENT.exec(value);
  if (!match) return undefined;
  // An all-zero identifier is the spec's "no trace", not a trace.
  const traceId = match[1];
  if (!traceId) return undefined;
  if (/^0+$/.test(traceId)) return undefined;
  return { traceId: traceId.toLowerCase(), spanId: hex(8) };
}

function header(headers: IncomingHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
