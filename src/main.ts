// Orchestration ONLY. Reads inputs, wires the isolated modules together, and
// sets outputs. All domain logic lives in the modules it composes.

import * as core from '@actions/core';
import * as github from '@actions/github';

import { decideRelease } from './release';
import {
  AnthropicProvider,
  OpenAiProvider,
  clampToBudget,
  platformCharBudget,
  summarizeRelease,
  templateSummary
} from './summarizer';
import { BufferClient, ScheduleOptions, ShareMode, SHARE_MODES } from './buffer';
import { RateLimiter } from './rateLimiter';
import { fetchHttpClient } from './http';
import {
  BufferPostResult,
  LlmProvider,
  ReleaseLike,
  SummarizeRequest
} from './types';

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

function parseScheduleMode(raw: string): ShareMode {
  const mode = (raw || 'addToQueue').trim() as ShareMode;
  if (!SHARE_MODES.includes(mode)) {
    throw new Error(
      `Invalid schedule_mode "${raw}". Allowed: ${SHARE_MODES.join(', ')}.`
    );
  }
  return mode;
}

export async function run(): Promise<void> {
  const bufferApiKey = core.getInput('buffer_api_key', { required: true });
  const channelIdsRaw = core.getInput('channel_ids', { required: true });
  const anthropicKey = core.getInput('anthropic_api_key');
  const openaiKey = core.getInput('openai_api_key');
  const llmModel = core.getInput('llm_model');
  const postTextOverride = core.getInput('post_text').trim();
  const charBudget = Number(core.getInput('char_budget') || '280');
  const majorOnly = (core.getInput('major_only') || 'true') !== 'false';
  const dryRun = (core.getInput('dry_run') || 'false') === 'true';
  const perPlatform = (core.getInput('per_platform') || 'false') === 'true';
  const scheduleMode = parseScheduleMode(core.getInput('schedule_mode'));
  const dueAt = core.getInput('due_at').trim();

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

  const baseBudget = Number.isFinite(charBudget) ? charBudget : 280;
  const rel = decision.release;
  const provider = postTextOverride
    ? null
    : selectProvider(anthropicKey, openaiKey, llmModel);

  // Produce post copy for a given character budget: verbatim override →
  // LLM (with template fallback on failure) → template. One place, reused
  // per-channel when per-platform sizing is on.
  const generate = async (budget: number): Promise<string> => {
    if (postTextOverride) return postTextOverride;
    const req: SummarizeRequest = {
      title: rel.title,
      notes: rel.notes,
      url: rel.url,
      charBudget: budget
    };
    if (provider) {
      try {
        return await summarizeRelease(req, provider);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        core.warning(`LLM summarization failed (${msg}); using template fallback.`);
        return clampToBudget(templateSummary(req), budget);
      }
    }
    return clampToBudget(templateSummary(req), budget);
  };

  if (postTextOverride) core.info('Using post_text override verbatim.');
  else if (provider) core.info(`Summarizing release notes with ${provider.name}...`);
  else core.info('No LLM key provided — using the built-in template summary.');

  const channelIds = parseChannelIds(channelIdsRaw);
  if (channelIds.length === 0) {
    throw new Error('No valid channel_ids provided.');
  }

  const limiter = new RateLimiter();
  const client = new BufferClient({
    apiKey: bufferApiKey,
    http: fetchHttpClient,
    limiter
  });

  // Build one post per channel. With per-platform sizing on (and no verbatim
  // override), resolve each channel's service and size the copy to it.
  const items: Array<{ channelId: string; text: string }> = [];
  if (perPlatform && !postTextOverride) {
    for (const channelId of channelIds) {
      const service = await client.getChannelService(channelId);
      const budget = platformCharBudget(service, baseBudget);
      const text = await generate(budget);
      core.info(
        `channel ${channelId} (${service ?? 'unknown'}, ≤${budget}): ${text.length} chars`
      );
      items.push({ channelId, text });
    }
  } else {
    const text = await generate(baseBudget);
    core.info(`Generated post (${text.length} chars):\n${text}`);
    for (const channelId of channelIds) items.push({ channelId, text });
  }

  // The primary post_text output is the first channel's copy.
  core.setOutput('post_text', items[0]?.text ?? '');

  const scheduleOpts: ScheduleOptions = { mode: scheduleMode, dueAt: dueAt || undefined };

  if (dryRun) {
    core.info(`dry_run=true — not calling Buffer (mode=${scheduleMode}).`);
    core.setOutput('skipped', 'false');
    core.setOutput('reason', 'Dry run: post generated but not enqueued.');
    return;
  }

  core.info(`Enqueuing to ${items.length} channel(s) (mode=${scheduleMode})...`);
  const results: BufferPostResult[] = await client.enqueueMany(items, scheduleOpts);
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
