// Transport-agnostic resilience layer: sliding-window pacing + retry/backoff.
// The clock (now/sleep) is injectable so tests run instantly and deterministically.

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

export interface RateLimiterOptions {
  /** Max requests permitted within the window. Default 90 (margin under 100). */
  maxRequests?: number;
  /** Window length in ms. Default 15 minutes. */
  windowMs?: number;
  clock?: Clock;
}

/**
 * Sliding-window pacer. `schedule()` serializes admission so that no more than
 * `maxRequests` requests start within any `windowMs` window. When the window is
 * full it awaits until the oldest in-window timestamp ages out — proactive
 * pacing rather than reacting to a 429.
 */
export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly clock: Clock;
  private timestamps: number[] = [];
  private chain: Promise<void> = Promise.resolve();
  /** When >0, admission is paused until this timestamp (server-imposed). */
  private pausedUntil = 0;

  constructor(opts: RateLimiterOptions = {}) {
    this.maxRequests = opts.maxRequests ?? 90;
    this.windowMs = opts.windowMs ?? 15 * 60 * 1000;
    this.clock = opts.clock ?? realClock;
  }

  /** Run `fn` once a slot is available, respecting the window. */
  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    // Serialize admission so concurrent callers can't race past the cap.
    const admitted = this.chain.then(() => this.awaitSlot());
    this.chain = admitted.catch(() => undefined);
    await admitted;
    return fn();
  }

  /**
   * Self-correct from the server's truth. Reads the IETF `RateLimit-Remaining`
   * and `RateLimit-Reset` (delta-seconds until the window resets) headers; if
   * the remaining budget is exhausted, pause admission until the reset. Header
   * names are matched case-insensitively. Unknown/absent headers are ignored,
   * so the static sliding window remains the floor.
   */
  observe(headers: Record<string, string>): void {
    const remaining = numHeader(headers, 'ratelimit-remaining');
    const resetSeconds = numHeader(headers, 'ratelimit-reset');
    if (remaining !== undefined && remaining <= 0 && resetSeconds !== undefined) {
      const until = this.clock.now() + Math.max(resetSeconds, 0) * 1000;
      if (until > this.pausedUntil) this.pausedUntil = until;
    }
  }

  private async awaitSlot(): Promise<void> {
    // Loop: honor any server-imposed pause, then prune; if full, sleep until
    // the oldest entry exits the window. Re-check after each sleep.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const pauseRemaining = this.pausedUntil - this.clock.now();
      if (pauseRemaining > 0) {
        await this.clock.sleep(pauseRemaining + 1);
        continue;
      }

      this.prune();
      if (this.timestamps.length < this.maxRequests) {
        this.timestamps.push(this.clock.now());
        return;
      }
      const oldest = this.timestamps[0];
      const waitMs = oldest + this.windowMs - this.clock.now();
      await this.clock.sleep(Math.max(waitMs, 0) + 1);
    }
  }

  private prune(): void {
    const cutoff = this.clock.now() - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);
  }
}

function numHeader(
  headers: Record<string, string>,
  name: string
): number | undefined {
  // Headers from http.ts are already lower-cased, but match defensively.
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

// ---------------------------------------------------------------------------
// Retry with backoff
// ---------------------------------------------------------------------------

export class RetryableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  clock?: Clock;
  /** Deterministic jitter in [0,1) for tests. Defaults to Math.random. */
  jitter?: () => number;
}

/** True for statuses that should be retried. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Retry a thunk on 429 / 5xx / network errors with exponential backoff and full
 * jitter. 429 honors a Retry-After (ms) when supplied via RetryableError.
 * Non-retryable errors (e.g. 4xx other than 429) propagate immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 60_000;
  const clock = opts.clock ?? realClock;
  const jitter = opts.jitter ?? Math.random;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof RetryableError;
      if (!retryable || attempt >= maxRetries) {
        throw err;
      }
      const re = err as RetryableError;
      const expo = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delay =
        re.retryAfterMs !== undefined
          ? re.retryAfterMs
          : Math.floor(expo * jitter());
      attempt += 1;
      await clock.sleep(delay);
    }
  }
}
