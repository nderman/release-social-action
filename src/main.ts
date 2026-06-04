// Orchestration ONLY. Reads inputs, wires the isolated modules together, and
// sets outputs. All domain logic lives in the modules it composes.

import * as core from '@actions/core';
import * as github from '@actions/github';

import { decideRelease } from './release';
import {
  AnthropicProvider,
  OpenAiProvider,
  clampToBudget,
  summarizeRelease,
  templateSummary
} from './summarizer';
import { BufferClient } from './buffer';
import { RateLimiter } from './rateLimiter';
import { fetchHttpClient } from './http';
import { BufferPostResult, LlmProvider, ReleaseLike } from './types';

function parseChannelIds(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function selectProvider(
  anthropicKey: string,
  openaiKey: string,
  model: string
): LlmProvider | null {
  const trimmedModel = model.trim() || undefined;
  if (anthropicKey) {
    return new AnthropicProvider(anthropicKey, trimmedModel);
  }
  if (openaiKey) {
    return new OpenAiProvider(openaiKey, trimmedModel);
  }
  // No key: caller falls back to the built-in template summarizer.
  return null;
}

export async function run(): Promise<void> {
  const bufferApiKey = core.getInput('buffer_api_key', { required: true });
  const channelIdsRaw = core.getInput('channel_ids', { required: true });
  const anthropicKey = core.getInput('anthropic_api_key');
  const openaiKey = core.getInput('openai_api_key');
  const llmModel = core.getInput('llm_model');
  const charBudget = Number(core.getInput('char_budget') || '280');
  const majorOnly = (core.getInput('major_only') || 'true') !== 'false';
  const dryRun = (core.getInput('dry_run') || 'false') === 'true';

  // Mask secrets in logs.
  for (const secret of [bufferApiKey, anthropicKey, openaiKey]) {
    if (secret) core.setSecret(secret);
  }

  // Sensible defaults so a clean skip never reports as posted.
  core.setOutput('posted', 'false');
  core.setOutput('skipped', 'false');
  core.setOutput('post_text', '');
  core.setOutput('results', '[]');

  const release = (github.context.payload.release ?? {}) as ReleaseLike;
  const decision = decideRelease(release, { majorOnly });

  if (!decision.shouldPost || !decision.release) {
    core.info(`Skipping: ${decision.reason}`);
    core.setOutput('skipped', 'true');
    core.setOutput('reason', decision.reason);
    return;
  }

  core.info(decision.reason);

  const summarizeReq = {
    title: decision.release.title,
    notes: decision.release.notes,
    url: decision.release.url,
    charBudget: Number.isFinite(charBudget) ? charBudget : 280
  };

  const provider = selectProvider(anthropicKey, openaiKey, llmModel);
  let postText: string;
  if (provider) {
    try {
      core.info(`Summarizing release notes with ${provider.name}...`);
      postText = await summarizeRelease(summarizeReq, provider);
    } catch (err) {
      // A dead key, no credits, or a rate limit shouldn't sink the run —
      // degrade gracefully to the deterministic template summary.
      const msg = err instanceof Error ? err.message : String(err);
      core.warning(`LLM summarization failed (${msg}); using template fallback.`);
      postText = clampToBudget(templateSummary(summarizeReq), summarizeReq.charBudget);
    }
  } else {
    core.info('No LLM key provided — using the built-in template summary.');
    postText = clampToBudget(templateSummary(summarizeReq), summarizeReq.charBudget);
  }
  core.setOutput('post_text', postText);
  core.info(`Generated post (${postText.length} chars):\n${postText}`);

  const channelIds = parseChannelIds(channelIdsRaw);
  if (channelIds.length === 0) {
    throw new Error('No valid channel_ids provided.');
  }

  if (dryRun) {
    core.info('dry_run=true — not calling Buffer.');
    core.setOutput('skipped', 'false');
    core.setOutput('reason', 'Dry run: post generated but not enqueued.');
    return;
  }

  const limiter = new RateLimiter();
  const client = new BufferClient({
    apiKey: bufferApiKey,
    http: fetchHttpClient,
    limiter
  });

  core.info(`Enqueuing to ${channelIds.length} channel(s)...`);
  const results: BufferPostResult[] = await client.enqueueToChannels(
    channelIds,
    postText
  );
  core.setOutput('results', JSON.stringify(results));

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  core.setOutput('posted', succeeded.length > 0 ? 'true' : 'false');

  for (const r of succeeded) {
    const slot = r.dueAt ? ` queued for ${r.dueAt}` : '';
    core.info(`✓ channel ${r.channelId} → post ${r.postId}${slot}`);
  }
  for (const r of failed) {
    core.warning(`✗ channel ${r.channelId}: ${r.error}`);
  }

  if (failed.length > 0) {
    const reason = `${succeeded.length}/${results.length} channels enqueued; ${failed.length} failed.`;
    core.setOutput('reason', reason);
    core.setFailed(reason);
    return;
  }

  core.setOutput('reason', `Enqueued to ${succeeded.length} channel(s).`);
}

// Entry point.
run().catch((err) => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
