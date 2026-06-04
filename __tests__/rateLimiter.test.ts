import {
  Clock,
  RateLimiter,
  RetryableError,
  isRetryableStatus,
  withRetry
} from '../src/rateLimiter';

/** A controllable virtual clock: sleep advances `now` instantly. */
function virtualClock(): Clock & { sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    }
  };
}

describe('isRetryableStatus', () => {
  it('flags 429 and 5xx, not other 4xx', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe('RateLimiter pacing', () => {
  it('admits up to maxRequests without waiting', async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 1000, clock });
    for (let i = 0; i < 3; i++) {
      await limiter.schedule(async () => i);
    }
    expect(clock.sleeps).toHaveLength(0);
  });

  it('waits until the oldest request ages out when the window is full', async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000, clock });

    await limiter.schedule(async () => 'a'); // t=0
    await limiter.schedule(async () => 'b'); // t=0, window now full
    await limiter.schedule(async () => 'c'); // must wait ~1000ms

    expect(clock.sleeps.length).toBeGreaterThanOrEqual(1);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(1000);
  });
});

describe('withRetry', () => {
  it('retries 429 honoring Retry-After (ms)', async () => {
    const clock = virtualClock();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw new RetryableError('429', 429, 2500);
        return 'ok';
      },
      { clock, baseDelayMs: 100 }
    );
    expect(result).toBe('ok');
    expect(clock.sleeps).toEqual([2500]);
  });

  it('retries 5xx with exponential backoff', async () => {
    const clock = virtualClock();
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new RetryableError('500', 500);
        return 'done';
      },
      { clock, baseDelayMs: 100, jitter: () => 1 }
    );
    expect(result).toBe('done');
    expect(calls).toBe(3);
    // base*2^0=100, base*2^1=200 with jitter() === 1
    expect(clock.sleeps).toEqual([100, 200]);
  });

  it('does not retry a non-retryable error', async () => {
    const clock = virtualClock();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('plain 400');
        },
        { clock }
      )
    ).rejects.toThrow('plain 400');
    expect(calls).toBe(1);
    expect(clock.sleeps).toHaveLength(0);
  });

  it('gives up after maxRetries and rethrows', async () => {
    const clock = virtualClock();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new RetryableError('500', 500);
        },
        { clock, maxRetries: 2, baseDelayMs: 1, jitter: () => 0 }
      )
    ).rejects.toThrow('500');
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('caps the backoff delay at maxDelayMs', async () => {
    const clock = virtualClock();
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 4) throw new RetryableError('500', 500);
        return 'ok';
      },
      { clock, baseDelayMs: 1000, maxDelayMs: 1500, jitter: () => 1 }
    );
    // 1000, 2000->capped 1500, 4000->capped 1500
    expect(clock.sleeps).toEqual([1000, 1500, 1500]);
  });
});
