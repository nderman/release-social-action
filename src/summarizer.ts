// LLM summarizing utility. Provider-agnostic: it depends only on the
// `LlmProvider` interface, never on a concrete SDK or on Buffer/release wire
// formats. Concrete providers live below and are lazily constructed at the edge.

import { LlmProvider, SummarizeRequest } from './types';

const SYSTEM_PROMPT = [
  'You are a developer-relations social media specialist.',
  'You write a single, punchy social post announcing a software release.',
  'Rules:',
  '- One post only. No preamble, no quotes, no markdown headings.',
  '- Lead with a strong hook, then 1-2 concrete highlights.',
  '- Include the release URL verbatim.',
  '- Add 1-3 relevant, specific hashtags.',
  '- Stay strictly within the character budget you are given.'
].join('\n');

export function buildPrompt(req: SummarizeRequest): string {
  return [
    `Release title: ${req.title}`,
    `Release URL: ${req.url}`,
    `Character budget (hard limit): ${req.charBudget}`,
    '',
    'Release notes:',
    req.notes || '(no notes provided)',
    '',
    `Write the social post now, within ${req.charBudget} characters.`
  ].join('\n');
}

/** Collapse whitespace and hard-truncate to budget on a word boundary. */
export function clampToBudget(text: string, budget: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= budget) return collapsed;

  const slice = collapsed.slice(0, budget);
  const lastSpace = slice.lastIndexOf(' ');
  // Only break on a word boundary if it doesn't throw away most of the text.
  const cut = lastSpace > budget * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.trim();
}

export async function summarizeRelease(
  req: SummarizeRequest,
  provider: LlmProvider
): Promise<string> {
  const prompt = buildPrompt(req);
  const raw = await provider.complete(prompt, SYSTEM_PROMPT);
  return clampToBudget(raw ?? '', req.charBudget);
}

/** First meaningful line of the notes, stripped of markdown noise. */
export function firstHighlight(notes: string): string {
  for (const raw of notes.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue; // skip blanks and headings
    line = line
      .replace(/^[-*+]\s+/, '') // bullet markers
      .replace(/^\d+\.\s+/, '') // numbered list
      .replace(/^>+\s*/, '') // block quotes
      .trim();
    if (line) return line;
  }
  return '';
}

/**
 * Deterministic, no-API post builder used when no LLM key is configured.
 * Produces a serviceable announcement from the release fields alone.
 */
export function templateSummary(req: SummarizeRequest): string {
  const parts = [`🚀 ${req.title} is out!`];
  const highlight = firstHighlight(req.notes);
  if (highlight) parts.push(highlight);
  if (req.url) parts.push(req.url);
  parts.push('#release');
  return clampToBudget(parts.join(' '), req.charBudget);
}

// ---------------------------------------------------------------------------
// Concrete providers — each lazily imports its SDK so the unused one never
// loads. Selected in main.ts based on which API key is present.
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;

  constructor(
    private readonly apiKey: string,
    private readonly model = 'claude-sonnet-4-6'
  ) {}

  async complete(prompt: string, system: string): Promise<string> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    const res = await client.messages.create({
      model: this.model,
      max_tokens: 512,
      system,
      messages: [{ role: 'user', content: prompt }]
    });
    return res.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  }
}

export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;

  constructor(
    private readonly apiKey: string,
    private readonly model = 'gpt-4o-mini'
  ) {}

  async complete(prompt: string, system: string): Promise<string> {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: this.apiKey });
    const res = await client.chat.completions.create({
      model: this.model,
      max_tokens: 512,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ]
    });
    return (res.choices[0]?.message?.content ?? '').trim();
  }
}
