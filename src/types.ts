// Shared domain types. No logic, no I/O — imported by every module so the
// concerns stay decoupled and individually testable.

/** A release as it arrives from the GitHub `release` event payload (subset). */
export interface ReleaseLike {
  tag_name?: string | null;
  name?: string | null;
  body?: string | null;
  html_url?: string | null;
  draft?: boolean | null;
  prerelease?: boolean | null;
}

/** A parsed, validated release ready to be summarized. */
export interface ParsedRelease {
  tag: string;
  title: string;
  notes: string;
  url: string;
  version: SemVer;
}

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/** Output of the release-detection step. Pure data — no side effects. */
export interface ReleaseDecision {
  shouldPost: boolean;
  reason: string;
  release?: ParsedRelease;
}

// ---------------------------------------------------------------------------
// Summarizer
// ---------------------------------------------------------------------------

export interface SummarizeRequest {
  title: string;
  notes: string;
  url: string;
  charBudget: number;
}

export interface LlmProvider {
  readonly name: 'openai' | 'anthropic';
  complete(prompt: string, system: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Buffer GraphQL client
// ---------------------------------------------------------------------------

export interface BufferPostResult {
  channelId: string;
  ok: boolean;
  postId?: string;
  status?: string;
  /** ISO timestamp Buffer assigned for the queued post, when returned. */
  dueAt?: string;
  error?: string;
}

/** Minimal HTTP response shape the client and rate-limiter understand. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body?: string;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;
