import {
  BufferClient,
  CREATE_POST_MUTATION,
  buildCreatePostBody
} from '../src/buffer';
import { RateLimiter } from '../src/rateLimiter';
import { HttpClient, HttpRequest, HttpResponse } from '../src/types';

function success(id: string, dueAt = '2026-03-10T15:00:00.000Z'): HttpResponse {
  return {
    status: 200,
    headers: {},
    body: {
      data: {
        createPost: { __typename: 'PostActionSuccess', post: { id, dueAt } }
      }
    }
  };
}

function mutationError(message: string): HttpResponse {
  return {
    status: 200,
    headers: {},
    body: { data: { createPost: { __typename: 'MutationError', message } } }
  };
}

// A limiter with a tiny window so tests never wait on real pacing.
function fastLimiter(): RateLimiter {
  return new RateLimiter({ maxRequests: 1000, windowMs: 1 });
}

describe('buildCreatePostBody', () => {
  it('produces the exact GraphQL payload structure', () => {
    const body = buildCreatePostBody('chan-1', 'Hello world');
    expect(body.query).toBe(CREATE_POST_MUTATION);
    expect(body.variables).toEqual({ channelId: 'chan-1', text: 'Hello world' });
  });

  it('uses the queue scheduling mode and automatic scheduling', () => {
    // Enum literals are inlined in the mutation (not passed as variables).
    expect(CREATE_POST_MUTATION).toContain('mode: addToQueue');
    expect(CREATE_POST_MUTATION).toContain('schedulingType: automatic');
    // No dueAt for queue mode — Buffer picks the next slot.
    expect(CREATE_POST_MUTATION).not.toContain('dueAt:');
  });

  it('selects both union members', () => {
    expect(CREATE_POST_MUTATION).toContain('... on PostActionSuccess');
    expect(CREATE_POST_MUTATION).toContain('... on MutationError');
  });
});

describe('BufferClient', () => {
  it('sends a Bearer token and JSON content type', async () => {
    const captured: HttpRequest[] = [];
    const http: HttpClient = async (req) => {
      captured.push(req);
      return success('p1');
    };
    const client = new BufferClient({
      apiKey: 'secret-token',
      http,
      limiter: fastLimiter()
    });

    const res = await client.enqueueToChannel('c1', 'post');
    expect(res).toEqual({
      channelId: 'c1',
      ok: true,
      postId: 'p1',
      status: 'PostActionSuccess',
      dueAt: '2026-03-10T15:00:00.000Z'
    });
    expect(captured[0].headers.Authorization).toBe('Bearer secret-token');
    expect(captured[0].headers['Content-Type']).toBe('application/json');
    expect(captured[0].url).toBe('https://api.buffer.com/graphql');

    const sent = JSON.parse(captured[0].body!);
    expect(sent.variables.channelId).toBe('c1');
    expect(sent.variables.text).toBe('post');
    expect(sent.query).toContain('mode: addToQueue');
  });

  it('feeds response headers into the rate limiter', async () => {
    const limiter = fastLimiter();
    const spy = jest.spyOn(limiter, 'observe');
    const http: HttpClient = async () => ({
      status: 200,
      headers: { 'ratelimit-remaining': '88', 'ratelimit-reset': '300' },
      body: { data: { createPost: { __typename: 'PostActionSuccess', post: { id: 'p' } } } }
    });
    const client = new BufferClient({ apiKey: 'k', http, limiter });

    await client.enqueueToChannel('c', 't');
    expect(spy).toHaveBeenCalledWith({
      'ratelimit-remaining': '88',
      'ratelimit-reset': '300'
    });
  });

  it('fans out one request per channel', async () => {
    const seen: string[] = [];
    const http: HttpClient = async (req) => {
      const id = JSON.parse(req.body!).variables.channelId;
      seen.push(id);
      return success(`post-${id}`);
    };
    const client = new BufferClient({ apiKey: 'k', http, limiter: fastLimiter() });

    const results = await client.enqueueToChannels(['a', 'b', 'c'], 'text');
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.map((r) => r.postId)).toEqual(['post-a', 'post-b', 'post-c']);
  });

  it('does not let one failing channel abort the rest', async () => {
    const http: HttpClient = async (req) => {
      const id = JSON.parse(req.body!).variables.channelId;
      if (id === 'bad') return mutationError('nope');
      return success(`post-${id}`);
    };
    const client = new BufferClient({ apiKey: 'k', http, limiter: fastLimiter() });

    const results = await client.enqueueToChannels(['good', 'bad', 'good2'], 't');
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain('nope');
    expect(results[2].ok).toBe(true);
  });

  it('treats a MutationError union member as a failure', async () => {
    const http: HttpClient = async () => mutationError('invalid channel');
    const client = new BufferClient({ apiKey: 'k', http, limiter: fastLimiter() });
    const res = await client.enqueueToChannel('c', 't');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('invalid channel');
  });

  it('treats top-level GraphQL errors[] as a failure', async () => {
    const http: HttpClient = async () => ({
      status: 200,
      headers: {},
      body: { errors: [{ message: 'bad query' }] }
    });
    const client = new BufferClient({ apiKey: 'k', http, limiter: fastLimiter() });
    const res = await client.enqueueToChannel('c', 't');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('bad query');
  });

  it('fails when the success post id is missing', async () => {
    const http: HttpClient = async () => ({
      status: 200,
      headers: {},
      body: { data: { createPost: null } }
    });
    const client = new BufferClient({ apiKey: 'k', http, limiter: fastLimiter() });
    const res = await client.enqueueToChannel('c', 't');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unexpected createPost result/);
  });

  it('retries on 429 then succeeds', async () => {
    let calls = 0;
    const http: HttpClient = async () => {
      calls += 1;
      if (calls === 1) {
        return { status: 429, headers: { 'retry-after': '0' }, body: {} };
      }
      return success('p');
    };
    const client = new BufferClient({
      apiKey: 'k',
      http,
      limiter: fastLimiter(),
      retry: { baseDelayMs: 0, jitter: () => 0 }
    });
    const res = await client.enqueueToChannel('c', 't');
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('retries when rate-limited via a GraphQL retryAfter extension on HTTP 200', async () => {
    let calls = 0;
    const http: HttpClient = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 200,
          headers: {},
          body: {
            errors: [
              { message: 'rate limited', extensions: { code: 'RATE_LIMITED', retryAfter: 0 } }
            ]
          }
        };
      }
      return success('p');
    };
    const client = new BufferClient({
      apiKey: 'k',
      http,
      limiter: fastLimiter(),
      retry: { baseDelayMs: 0, jitter: () => 0 }
    });
    const res = await client.enqueueToChannel('c', 't');
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('returns a failure on a non-retryable 4xx', async () => {
    const http: HttpClient = async () => ({ status: 401, headers: {}, body: {} });
    const client = new BufferClient({ apiKey: 'k', http, limiter: fastLimiter() });
    const res = await client.enqueueToChannel('c', 't');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('401');
  });
});
