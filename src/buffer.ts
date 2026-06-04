// Buffer GraphQL client. Builds the `createPost` mutation and fans out one
// request per channel. Knows nothing about LLMs or release semantics. Resilience
// and transport are injected (RateLimiter + HttpClient), so this is fully testable.
//
// Schema verified by live introspection of api.buffer.com/graphql:
//   - createPost(input: CreatePostInput) returns a UNION; success member is
//     `PostActionSuccess { post { id dueAt } }`, error member `MutationError`.
//   - channelId: ChannelId!  text: String  schedulingType: SchedulingType
//     (automatic|notification)  dueAt: DateTime  mode: ShareMode.
//   - ShareMode = addToQueue|shareNow|shareNext|customScheduled|recommendedTime.
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

/** Buffer ShareMode enum values (how the post enters the schedule). */
export type ShareMode =
  | 'addToQueue'
  | 'shareNow'
  | 'shareNext'
  | 'customScheduled'
  | 'recommendedTime';

export const SHARE_MODES: ShareMode[] = [
  'addToQueue',
  'shareNow',
  'shareNext',
  'customScheduled',
  'recommendedTime'
];

export interface ScheduleOptions {
  /** How the post enters the channel schedule. Default `addToQueue`. */
  mode?: ShareMode;
  /** ISO-8601 timestamp; required when `mode === 'customScheduled'`. */
  dueAt?: string;
}

// Permissive ISO-8601 with timezone (Z or ±hh:mm). We validate before inlining.
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export interface CreatePostVariables {
  channelId: string;
  text: string;
}

// Enum/scalar literals (mode, schedulingType, dueAt) are inlined as GraphQL
// literals; only channelId/text travel as typed variables, so user-supplied
// text can never break out of its variable into the query. `mode` is validated
// against SHARE_MODES and `dueAt` against ISO-8601 before inlining.
function buildMutation(fields: string[]): string {
  return `mutation CreatePost($channelId: ChannelId!, $text: String!) {
  createPost(input: { ${fields.join(', ')} }) {
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
}

/** The default queue mutation (kept for reference/tests). */
export const CREATE_POST_MUTATION = buildMutation([
  'channelId: $channelId',
  'text: $text',
  'schedulingType: automatic',
  'mode: addToQueue'
]);

export function buildCreatePostBody(
  channelId: string,
  text: string,
  opts: ScheduleOptions = {}
): { query: string; variables: CreatePostVariables } {
  const mode: ShareMode = opts.mode ?? 'addToQueue';
  if (!SHARE_MODES.includes(mode)) {
    throw new Error(`Invalid schedule mode: ${mode}`);
  }
  const fields = [
    'channelId: $channelId',
    'text: $text',
    'schedulingType: automatic',
    `mode: ${mode}`
  ];
  if (mode === 'customScheduled') {
    if (!opts.dueAt) {
      throw new Error('due_at is required when schedule_mode=customScheduled');
    }
    if (!ISO_8601.test(opts.dueAt)) {
      throw new Error(`due_at must be an ISO-8601 timestamp, got: ${opts.dueAt}`);
    }
    fields.push(`dueAt: "${opts.dueAt}"`);
  }
  return { query: buildMutation(fields), variables: { channelId, text } };
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

  /** Enqueue the same `text` to every channel. One failure never aborts the rest. */
  async enqueueToChannels(
    channelIds: string[],
    text: string,
    opts: ScheduleOptions = {}
  ): Promise<BufferPostResult[]> {
    return this.enqueueMany(
      channelIds.map((channelId) => ({ channelId, text })),
      opts
    );
  }

  /** Enqueue per-channel text (used for per-platform variants). */
  async enqueueMany(
    items: Array<{ channelId: string; text: string }>,
    opts: ScheduleOptions = {}
  ): Promise<BufferPostResult[]> {
    const results: BufferPostResult[] = [];
    for (const item of items) {
      results.push(await this.enqueueToChannel(item.channelId, item.text, opts));
    }
    return results;
  }

  async enqueueToChannel(
    channelId: string,
    text: string,
    opts: ScheduleOptions = {}
  ): Promise<BufferPostResult> {
    try {
      const res = await this.limiter.schedule(() =>
        withRetry(() => this.post(channelId, text, opts), this.retry)
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

  /**
   * Best-effort: resolve a channel's platform (linkedin, twitter, ...) so the
   * caller can size/tailor the post per network. Fail-open — returns null on any
   * error so per-platform sizing never blocks posting.
   */
  async getChannelService(channelId: string): Promise<string | null> {
    try {
      const res = await this.limiter.schedule(() =>
        withRetry(
          () =>
            this.gql(
              'query Channel($input: ChannelInput!) { channel(input: $input) { id service } }',
              { input: { id: channelId } }
            ),
          this.retry
        )
      );
      const body = res.body as
        | { data?: { channel?: { service?: string } | null } }
        | undefined;
      return body?.data?.channel?.service ?? null;
    } catch {
      return null;
    }
  }

  private async post(
    channelId: string,
    text: string,
    opts: ScheduleOptions
  ): Promise<HttpResponse> {
    const body = buildCreatePostBody(channelId, text, opts);
    return this.gql(body.query, body.variables);
  }

  /** Single GraphQL POST: sends, feeds rate-limit headers back, flags retryables. */
  private async gql(query: string, variables: object): Promise<HttpResponse> {
    const res = await this.http({
      url: this.endpoint,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query, variables })
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
