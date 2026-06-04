# SPECIFICATION — `release-social-action`

A composable, open-source **GitHub Action** that detects **major** version
releases, generates an optimized social-media post from the release notes using
an LLM, and schedules it across platforms via the **Buffer GraphQL API**.

---

## 1. Purpose & Scope

When a release is published in a repository, this Action:

1. Reads the release payload (tag, name, body/notes, URL, prerelease flag).
2. Determines whether the release is a **major** version bump (e.g. `v1.0.0` →
   `v2.0.0`). Non-major / prerelease / draft releases are skipped cleanly.
3. Sends the release notes to an LLM (OpenAI **or** Anthropic) which returns a
   short, platform-appropriate social post (with hashtags, within character
   budget, link included).
4. Enqueues that post to one or more **Buffer channels** using the Buffer
   GraphQL `createPost` mutation with `mode: addToQueue`.

The Action is intended to be invoked from a workflow triggered on
`release: { types: [published] }`, but is also runnable manually for testing.

---

## 2. Technology Stack

| Concern              | Choice                                                        |
| -------------------- | ------------------------------------------------------------- |
| Language             | **TypeScript** (strict), compiled to ES2022 / CommonJS        |
| Runtime              | **Node.js 20** (GitHub Actions `node20` runtime)              |
| Actions toolkit      | `@actions/core`, `@actions/github`                            |
| HTTP                 | Native `fetch` (Node 20 global) — **no** axios/node-fetch dep |
| LLM SDKs             | `openai`, `@anthropic-ai/sdk` (lazy-loaded per provider)      |
| Test framework       | **Jest** + `ts-jest`                                          |
| Bundler/distribution | **`@vercel/ncc`** → single `dist/index.js`                    |
| Lint/format          | TypeScript compiler (`tsc --noEmit`) as the gate              |

No legacy Buffer REST endpoints are used. All Buffer traffic is GraphQL over
HTTPS to `https://api.buffer.com/graphql`.

---

## 3. Architecture

The codebase enforces **complete isolation** between the three core concerns.
Each module is pure with respect to its dependencies (injected, not imported as
singletons), so each can be unit-tested without network or the Actions runtime.

```
src/
  main.ts          Orchestration ONLY. Reads inputs, wires modules, sets outputs.
  types.ts         Shared domain types & interfaces (no logic).
  release.ts       Release-parsing logic. Pure functions. No I/O.
  summarizer.ts    LLM summarizing utility. Provider-agnostic interface.
  buffer.ts        Buffer GraphQL client. Builds payloads, calls the API.
  rateLimiter.ts   Pacing/queue + retry. Transport-agnostic resilience layer.
  http.ts          Thin fetch wrapper (so transport is mockable/injectable).
```

### 3.1 Isolation contract

- **`release.ts`** knows nothing about LLMs or Buffer. It accepts a release-like
  object and returns a `ParsedRelease` / `ReleaseDecision`. Pure, deterministic,
  no `process.env`, no network.
- **`summarizer.ts`** knows nothing about GitHub releases' wire format or about
  Buffer. It takes a `SummarizeRequest` (notes, title, url, platform hints,
  char budget) and a `LlmProvider` and returns a `string`. The provider is an
  interface (`LlmProvider`) with concrete `OpenAiProvider` / `AnthropicProvider`
  implementations selected at the edge (in `main.ts`).
- **`buffer.ts`** knows nothing about LLMs or release semantics. It takes a
  finished post string + channel IDs and emits GraphQL mutations. It depends on
  `rateLimiter.ts` and `http.ts` only via injection.

The data flows strictly one direction:
`release.ts → summarizer.ts → buffer.ts`, orchestrated by `main.ts`.

---

## 4. Release Detection Logic (`release.ts`)

- Parse the incoming tag with a lenient SemVer regex that tolerates a leading
  `v` and optional pre-release/build metadata: `^v?(\d+)\.(\d+)\.(\d+)`.
- A release is **major** when `minor === 0 && patch === 0 && major >= 1`
  (i.e. the tag is `X.0.0`). This is the default rule.
- **Skip** (return a `ReleaseDecision` with `shouldPost: false` and a reason)
  when any of the following hold:
  - the release is a **draft** or **prerelease**;
  - the tag fails to parse as SemVer;
  - the tag is not a major bump under the rule above.
- An input `major_only` (default `true`) controls whether the major gate is
  enforced. When `false`, any non-draft/non-prerelease release posts.
- The function is **side-effect free**; `main.ts` decides what to do with the
  decision (and logs/sets outputs accordingly).

---

## 5. LLM Summarizer (`summarizer.ts`)

- Interface:
  ```ts
  interface LlmProvider {
    readonly name: 'openai' | 'anthropic';
    complete(prompt: string, system: string): Promise<string>;
  }
  ```
- `summarizeRelease(req: SummarizeRequest, provider: LlmProvider)` builds a
  deterministic prompt (system + user) instructing the model to produce a
  single social post: punchy hook, 1–2 key changes, the release URL, and 1–3
  relevant hashtags, within `req.charBudget` (default **280**, the most
  restrictive common limit).
- Output is post-processed: trimmed, collapsed whitespace, hard-truncated to the
  char budget on a word boundary as a safety net (the model is asked to comply,
  but we never trust it to).
- Provider selection happens in `main.ts`: prefer Anthropic if
  `anthropic_api_key` is set, else OpenAI if `openai_api_key` is set. Default
  models: Anthropic `claude-sonnet-4-6`, OpenAI `gpt-4o-mini` (both overridable
  via `llm_model` input).
- **LLM is optional.** If neither key is supplied, `templateSummary()` builds a
  deterministic post from the release title/notes/URL (no API call, no cost).
  The LLM path is additionally wrapped so that a failed call (dead key, no
  credits, rate limit) degrades to the same template rather than failing the run.
- Concrete providers (`OpenAiProvider`, `AnthropicProvider`) lazily `import()`
  their SDK so the unused SDK never loads.

---

## 6. Buffer GraphQL Integration (`buffer.ts`)

Schema verified against Buffer's developer docs
([data-model](https://developers.buffer.com/guides/data-model.html),
[posts-and-scheduling](https://developers.buffer.com/guides/posts-and-scheduling.html)).

- Endpoint: `POST https://api.buffer.com/graphql` (base host
  `https://api.buffer.com` per the auth docs; the GraphQL path is the action's
  overridable default).
- Auth: `Authorization: Bearer <buffer_api_key>` header; `Content-Type:
  application/json`. A missing/invalid key returns `401 Unauthorized`.
- **Queue-first scheduling (preferred).** Posts are added to the channel's
  posting queue with `mode: addToQueue` + `schedulingType: automatic`, and **no
  `dueAt`** — Buffer assigns the next free slot. (The alternative
  `mode: customScheduled` requires an explicit `dueAt`; not used here.)
- One GraphQL request **per channel** (`createPost` targets a single channel).
  Enum values are inlined as GraphQL enum literals; only the scalars travel as
  typed variables, so the client never depends on the exact input-type name:

  ```graphql
  mutation CreatePost($channelId: String!, $text: String!) {
    createPost(
      input: { channelId: $channelId, text: $text, schedulingType: automatic, mode: addToQueue }
    ) {
      __typename
      ... on PostActionSuccess {
        post { id dueAt }
      }
      ... on MutationError {
        message
      }
    }
  }
  ```

- `createPost` returns a **union**. Success is `PostActionSuccess { post { id
  dueAt } }`; the error member is `MutationError { message }`. The client
  branches on `__typename`.
- The client returns a normalized `BufferPostResult { channelId, postId,
  status, dueAt?, ok, error? }` per channel and never throws for a
  single-channel failure — failures are collected so one bad channel does not
  abort the rest.
- Three distinct failure surfaces are handled: transport/HTTP non-2xx,
  top-level GraphQL `errors[]`, and the `MutationError` union member.

---

## 7. Resilience — Rate Limiting & Retry (`rateLimiter.ts`)

Buffer's limit is **per API key**: **100 requests / 15 minutes** (the binding
window for this Action), plus per-plan 24-hour (100–500) and 30-day
(3,000–15,000) ceilings. Exceeding it returns HTTP `429` with `RateLimit-Limit`
/ `RateLimit-Remaining` / `RateLimit-Reset` headers, and the GraphQL error
carries a `retryAfter` (seconds) **extension** (not a standard `Retry-After`
header).

- **Pacing (sliding window):** `RateLimiter` records the timestamp of each
  request in a window. Before issuing a request it prunes timestamps older than
  the window; if the window is full it **awaits** until the oldest timestamp
  ages out, then proceeds. This guarantees we never exceed the cap rather than
  reacting after a 429.
- A conservative default `maxRequests = 90` (a 10% safety margin under 100) over
  `windowMs = 15 * 60 * 1000`. Both overridable for tests.
- **Server-header self-correction:** `observe(headers)` reads the IETF
  `RateLimit-Remaining` / `RateLimit-Reset` (delta-seconds) headers Buffer
  returns on every response. When the remaining budget is exhausted, admission
  is paused until the server-reported reset — so the limiter corrects from
  Buffer's truth rather than relying solely on the static window. The Buffer
  client calls `observe()` after each response. Absent/non-numeric headers are
  ignored, leaving the static window as the floor.
- **Retry with backoff:** `withRetry()` wraps a request thunk. It retries on:
  - HTTP `429` **or** an HTTP-200 GraphQL rate-limit error — honoring the
    `retryAfter` extension (seconds) when present, else a `Retry-After` header,
    else exponential backoff;
  - HTTP `5xx` and network errors — exponential backoff with full jitter;
  - up to `maxRetries` (default 5). 4xx other than 429 are **not** retried.
- The clock is injectable (`now()` + `sleep()`), so tests run deterministically
  with no real waiting.
- `buffer.ts` routes every GraphQL call through
  `rateLimiter.schedule(() => withRetry(() => http(...)))`.

---

## 8. Inputs / Outputs (`action.yml`)

### Inputs

| Input              | Required | Default      | Description                                                       |
| ------------------ | -------- | ------------ | ----------------------------------------------------------------- |
| `buffer_api_key`   | yes      | —            | Buffer API access token (Bearer).                                 |
| `channel_ids`      | yes      | —            | Comma- or newline-separated Buffer channel IDs to enqueue to.     |
| `openai_api_key`   | no\*     | —            | OpenAI API key. \*One of OpenAI/Anthropic key is required.        |
| `anthropic_api_key`| no\*     | —            | Anthropic API key. Preferred when both are supplied.              |
| `llm_model`        | no       | provider def | Override model id.                                                |
| `char_budget`      | no       | `280`        | Max characters for the generated post.                            |
| `major_only`       | no       | `true`       | Only post on `X.0.0` major releases.                              |
| `dry_run`          | no       | `false`      | Generate the post and log it, but do **not** call Buffer.         |
| `github_token`     | no       | `github.token`| Token used to enrich/fetch release context if needed.            |

### Outputs

| Output        | Description                                                       |
| ------------- | ----------------------------------------------------------------- |
| `posted`      | `'true'` / `'false'` — whether any post was enqueued.             |
| `skipped`     | `'true'` / `'false'` — whether the release was skipped.           |
| `reason`      | Human-readable reason (skip reason or success summary).           |
| `post_text`   | The generated social post text.                                   |
| `results`     | JSON array of per-channel `BufferPostResult`.                     |

### Action metadata

- `runs.using: node20`, `runs.main: dist/index.js`.

---

## 9. Testing Strategy

Unit tests (Jest, fully offline — no network, no real Actions runtime):

- **`release.test.ts`** — SemVer parsing edge cases; major vs minor vs patch;
  draft/prerelease skips; `v` prefix; malformed tags; `major_only` toggle.
- **`buffer.test.ts`** — exact **GraphQL payload structure** (mutation string,
  `input.mode === 'addToQueue'`, channelId/text wiring); per-channel result
  normalization; GraphQL `errors[]` handling; multi-channel fan-out with one
  failure not aborting others. HTTP is injected as a mock.
- **`summarizer.test.ts`** — prompt construction; char-budget truncation on word
  boundary; provider abstraction (a fake `LlmProvider`); whitespace cleanup.
- **`rateLimiter.test.ts`** — window pacing waits when full (injected clock);
  retry on 429 honoring `Retry-After`; retry on 5xx; no retry on 400; backoff
  cap.

The build gate is: `tsc --noEmit` (types) + `jest` (behavior) + `ncc build`
(distribution bundle compiles).

---

## 10. Distribution

- `npm run build` → `ncc build src/main.ts -o dist --minify` producing a single
  committed `dist/index.js` (GitHub Actions runs the committed bundle; node
  dependencies are inlined).
- `dist/` is committed (standard for JS Actions) so consumers need no install
  step.

---

## 11. Security & Failure Posture

- Secrets (`buffer_api_key`, LLM keys) are read via `@actions/core.getInput` and
  registered with `core.setSecret` so they are masked in logs.
- A failure to post to Buffer fails the Action (`core.setFailed`) **after** all
  channels are attempted, with a JSON summary in `results`.
- A skip (non-major release) is a **success** with `skipped=true`, never a
  failure — workflows triggered on every release must not turn red on minors.
- `dry_run` short-circuits all Buffer calls for safe end-to-end rehearsal.
