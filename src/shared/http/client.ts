import { withTimeout } from "@/shared/deadline";
import { currentTrace, traceparentOf } from "@/shared/trace";

// The outgoing HTTP client: `fetch` plus a deadline. Nothing else. It knows neither truco nor money
// nor tournaments, which is what lets it live in `shared/`.
//
// **It does not retry, and that is deliberate.** The loop the repo already has sleeps BEFORE each
// attempt, the first one included: using it here would add half a second to every call even when it
// succeeds, and all of these are on the critical path to starting a match. But the real reason is
// correctness: **a POST that moves money is not retried**. If the request landed and the response was
// lost, the second attempt charges again. Whoever needs retries — the prize delivery, the
// participation report — does not come through here: it goes out on the queue, with an outbox behind.
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The other side answered, but with an error. It is told apart from a network
 * failure because the `status` decides: a 400 on a charge is "they cannot afford
 * it", which is an answer, while a 502 is "it could not be asked".
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = "HttpError";
  }
}

export interface HttpClientOptions {
  // Already normalised with a trailing slash by `env.ts`.
  readonly baseUrl: string;
  readonly timeoutMs?: number;
}

export class HttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor({ baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS }: HttpClientOptions) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async get<T>(path: string, headers: Record<string, string> = {}): Promise<T> {
    return this.send<T>(path, { method: "GET", headers });
  }

  async post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
    return this.send<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  private async send<T>(path: string, init: RequestInit): Promise<T> {
    const response = await withTimeout(
      fetch(`${this.baseUrl}${path}`, { ...init, headers: { ...init.headers, ...traceHeaders() } }),
      this.timeoutMs,
    );
    if (!response.ok) throw new HttpError(response.status, await safeText(response));
    return parse<T>(response);
  }
}

// The body of an error cannot bring down the handling of that error. If it will not be read, the
// `status` is already enough to decide.
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// The backend answers JSON, but not always an object: a balance arrives as a bare number and a
// charge as `null`. `response.json()` handles all three; a `204` with no body, it does not.
async function parse<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (text.length === 0) return undefined as T;
  return JSON.parse(text) as T;
}

// The cause in progress, ATTACHED ON THE WAY OUT. It goes in `send` and not at each call, which is
// what keeps this from costing any adapter a parameter.
//
// BOTH headers are sent and they say the same thing. The W3C one is the real one; `x-request-id` is
// for a consumer that does not speak it yet, and it carries the bare `traceId` precisely so both ways
// of reading it give the same value and the join works either way.
function traceHeaders(): Record<string, string> {
  const trace = currentTrace();
  if (trace === undefined) return {};
  return { traceparent: traceparentOf(trace), "x-request-id": trace.traceId };
}
