# Release Social Scheduler

A GitHub Action that detects **major** version releases, generates an optimized
social-media post from the release notes using an LLM (OpenAI **or** Anthropic),
and schedules it across your platforms via the **Buffer GraphQL API**
(`createPost` mutation, `mode: addToQueue`).

See [`SPECIFICATION.md`](./SPECIFICATION.md) for the full design.

## How it works

```
release.ts  →  summarizer.ts  →  buffer.ts
 (detect)        (LLM post)       (enqueue)
        orchestrated by main.ts
```

Each concern is fully isolated and unit-tested in complete isolation: release
parsing is pure, the summarizer depends only on an `LlmProvider` interface, and
the Buffer client takes its transport and rate-limiter by injection.

- **Major detection** — posts only on `X.0.0` tags (toggle with `major_only`).
  Drafts, prereleases, and non-SemVer tags are skipped as a clean success.
- **LLM optional** — if you set an OpenAI or Anthropic key, the post is
  LLM-written. If you set **neither**, a built-in deterministic template builds
  the post from the release title/notes/URL — no API cost. The LLM path also
  falls back to the template if the API call fails (dead key, no credits, rate
  limit), so a run never dies on the summarizer.
- **Resilience** — a sliding-window pacer keeps you under Buffer's
  100-requests / 15-minutes limit (default 90 with margin), plus retry with
  exponential backoff + jitter on `429`/`5xx`, honoring `Retry-After`.
- **No legacy REST** — all Buffer traffic is GraphQL over HTTPS via native
  `fetch`.

## Usage

```yaml
name: Announce release
on:
  release:
    types: [published]

permissions:
  contents: read

jobs:
  announce:
    runs-on: ubuntu-latest
    steps:
      - uses: nderman/release-social-action@v1
        with:
          buffer_api_key: ${{ secrets.BUFFER_API_KEY }}
          channel_ids: ${{ vars.BUFFER_CHANNEL_IDS }}   # comma/newline separated
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          # or: openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

## Inputs

| Input               | Required | Default          | Description                                            |
| ------------------- | -------- | ---------------- | ------------------------------------------------------ |
| `buffer_api_key`    | yes      | —                | Buffer API token (Bearer).                             |
| `channel_ids`       | yes      | —                | Buffer channel IDs, comma- or newline-separated.       |
| `openai_api_key`    | no\*     | —                | OpenAI key. \*One LLM key required.                    |
| `anthropic_api_key` | no\*     | —                | Anthropic key. Preferred when both are set.            |
| `llm_model`         | no       | per-provider     | Override the model id.                                 |
| `char_budget`       | no       | `280`            | Max characters for the post.                           |
| `major_only`        | no       | `true`           | Only post on `X.0.0` releases.                         |
| `dry_run`           | no       | `false`          | Generate + log the post but skip Buffer.               |
| `github_token`      | no       | `github.token`   | Token for reading release context.                     |

## Outputs

| Output      | Description                                       |
| ----------- | ------------------------------------------------- |
| `posted`    | `'true'` if any post was enqueued.                |
| `skipped`   | `'true'` if the release was skipped.              |
| `reason`    | Skip reason or success summary.                   |
| `post_text` | The generated social post text.                   |
| `results`   | JSON array of per-channel results.                |

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # jest (fully offline)
npm run build       # ncc → dist/index.js (committed)
npm run all         # all three
```

`dist/index.js` is committed because GitHub Actions runs the bundled output
directly. Rebuild and commit it whenever `src/` changes.

## License

MIT
