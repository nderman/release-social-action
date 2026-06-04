// Buffer GraphQL client. Builds the `createPost` mutation and fans out one
// request per channel. Knows nothing about LLMs or release semantics. Resilience
// and transport are injected (RateLimiter + HttpClient), so this is fully testable.
//
// Schema verified against https://developers.buffer.com/guides/data-model.html :
//   - createPost(input: {...}) returns a UNION; the success member is
//     `PostActionSuccess { post { id text } }`.
//   - input carries `schedulingType: automatic` and `mode: addToQueue` (enums).
// Rate limits (per API key): 100 requests / 15 min; 429 on exceed; the
// `retryAfter` (seconds) is delivered as a GraphQL error *extension*.

import { BufferPostResult, HttpClient, HttpResponse } from './types';
import {
  RateLimiter,
  RetryableError,
  isRetryableStatus,
  withRetry,
  RetryOptions
} from './rateLimiter';

export const BUFFER_GRAPHQL_ENDPOINT = 'https://api.buffer.com/graphql';

// Enum values (`automatic`, `addToQueue`) are inlined as GraphQL enum literals.
// Only the scalar values travel as typed variables, so we never depend on the
// exact name of the input object type.
export const CREATE_POST_MUTATION = `mutation CreatePost($channelId: ChannelId!, $text: String!) {
  createPost(
    input: { channelId: $channelId, text: $text, schedulingType: automatic, mode: addToQueue }
  ) {
    __typename
    ... on PostActionSuccess {
      post {
        id
        dueAt
      }
    }
    ... on MutationError {
      message
    }
  }
}`;

export interface CreatePostVariables {
  channelId: string;
  text: string;
}

export function buildCreatePostBody(
  channelId: string,
  text: string
): { query: string; variables: CreatePostVariables } {
  return {
    query: CREATE_POST_MUTATION,
    variables: { channelId, text }
  };
}

export interface BufferClientOptions {
  apiKey: string;
  http: HttpClient;
  limiter: RateLimiter;
  endpoint?: string;
  retry?: RetryOptions;
}

interface GraphQLError {
  message?: string;
  extensions?: { retryAfter?: number; code?: string };
}

interface GraphQLEnvelope {
  data?: {
    createPost?: {
      __typename?: string;
      post?: { id?: string; dueAt?: string } | null;
      message?: string;
    } | null;
  } | null;
  errors?: GraphQLError[];
}

/**
 * Determine how long to wait before retrying, preferring Buffer's GraphQL
 * `retryAfter` extension (seconds), then a standard `Retry-After` header.
 */
function extractRetryAfterMs(res: HttpResponse): number | undefined {
  const body = res.body as GraphQLEnvelope | undefined;
  const ext = body?.errors?.find((e) => typeof e.extensions?.retryAfter === 'number')
    ?.extensions?.retryAfter;
  if (typeof ext === 'number') return Math.max(ext, 0) * 1000;

  const raw = res.headers['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isNaN(seconds)) return Math.max(seconds, 0) * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(date - Date.now(), 0);
  return undefined;
}

/** True when a GraphQL error envelope indicates rate limiting. */
function isRateLimited(body: GraphQLEnvelope | undefined): boolean {
  return Boolean(
    body?.errors?.some(
      (e) =>
        typeof e.extensions?.retryAfter === 'number' ||
        e.extensions?.code === 'RATE_LIMITED'
    )
  );
}

export class BufferClient {
  private readonly apiKey: string;
  private readonly http: HttpClient;
  private readonly limiter: RateLimiter;
  private readonly endpoint: string;
  private readonly retry?: RetryOptions;

  constructor(opts: BufferClientOptions) {
    this.apiKey = opts.apiKey;
    this.http = opts.http;
    this.limiter = opts.limiter;
    this.endpoint = opts.endpoint ?? BUFFER_GRAPHQL_ENDPOINT;
    this.retry = opts.retry;
  }

  /** Enqueue `text` to every channel. One bad channel never aborts the rest. */
  async enqueueToChannels(
    channelIds: string[],
    text: string
  ): Promise<BufferPostResult[]> {
    const results: BufferPostResult[] = [];
    for (const channelId of channelIds) {
      results.push(await this.enqueueToChannel(channelId, text));
    }
    return results;
  }

  async enqueueToChannel(
    channelId: string,
    text: string
  ): Promise<BufferPostResult> {
    try {
      const res = await this.limiter.schedule(() =>
        withRetry(() => this.post(channelId, text), this.retry)
      );
      return this.normalize(channelId, res);
    } catch (err) {
      return {
        channelId,
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  private async post(channelId: string, text: string): Promise<HttpResponse> {
    const body = buildCreatePostBody(channelId, text);
    const res = await this.http({
      url: this.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    });

    // Feed the server's RateLimit-* headers back into the pacer so it
    // self-corrects from Buffer's truth rather than only the static window.
    this.limiter.observe(res.headers);

    // Retryable transport status (429/5xx), OR a GraphQL-level rate-limit signal
    // delivered on an HTTP 200. Either way, throw so withRetry can back off.
    const envelope = res.body as GraphQLEnvelope | undefined;
    if (isRetryableStatus(res.status) || isRateLimited(envelope)) {
      throw new RetryableError(
        `Buffer API rate-limited or transient error (status ${res.status})`,
        res.status,
        extractRetryAfterMs(res)
      );
    }
    return res;
  }

  private normalize(channelId: string, res: HttpResponse): BufferPostResult {
    const envelope = (res.body ?? {}) as GraphQLEnvelope;

    // GraphQL errors can accompany various HTTP statuses; surface them first.
    if (envelope.errors && envelope.errors.length > 0) {
      return {
        channelId,
        ok: false,
        error: envelope.errors.map((e) => e.message ?? 'unknown').join('; ')
      };
    }

    if (res.status < 200 || res.status >= 300) {
      const detail =
        typeof res.body === 'string'
          ? res.body
          : JSON.stringify(res.body ?? {});
      return {
        channelId,
        ok: false,
        error: `HTTP ${res.status}: ${detail.slice(0, 500)}`
      };
    }

    const createPost = envelope.data?.createPost;
    if (
      createPost?.__typename === 'PostActionSuccess' &&
      createPost.post?.id
    ) {
      return {
        channelId,
        ok: true,
        postId: createPost.post.id,
        status: createPost.__typename,
        dueAt: createPost.post.dueAt
      };
    }

    // The union's error member (MutationError) carries a human message.
    if (createPost?.message) {
      return { channelId, ok: false, error: createPost.message };
    }

    return {
      channelId,
      ok: false,
      error: `Unexpected createPost result: ${createPost?.__typename ?? 'null'}`
    };
  }
}
