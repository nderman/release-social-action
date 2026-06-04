import {
  buildPrompt,
  clampToBudget,
  summarizeRelease
} from '../src/summarizer';
import { LlmProvider } from '../src/types';

describe('buildPrompt', () => {
  it('includes title, url, budget and notes', () => {
    const p = buildPrompt({
      title: 'Foo 2.0',
      url: 'https://x.test/2',
      notes: 'Rewrote the engine',
      charBudget: 200
    });
    expect(p).toContain('Foo 2.0');
    expect(p).toContain('https://x.test/2');
    expect(p).toContain('200');
    expect(p).toContain('Rewrote the engine');
  });

  it('handles empty notes', () => {
    const p = buildPrompt({ title: 't', url: 'u', notes: '', charBudget: 100 });
    expect(p).toContain('(no notes provided)');
  });
});

describe('clampToBudget', () => {
  it('collapses whitespace', () => {
    expect(clampToBudget('a   b\n\nc', 100)).toBe('a b c');
  });

  it('returns text unchanged when within budget', () => {
    expect(clampToBudget('short post', 280)).toBe('short post');
  });

  it('truncates on a word boundary when over budget', () => {
    const text = 'one two three four five six seven eight nine ten';
    const out = clampToBudget(text, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith(' ')).toBe(false);
    // Should not cut mid-word.
    expect(text.startsWith(out)).toBe(true);
  });

  it('hard-cuts when no good word boundary exists', () => {
    const out = clampToBudget('supercalifragilisticexpialidocious', 10);
    expect(out.length).toBe(10);
  });
});

describe('summarizeRelease', () => {
  it('routes through the provider and clamps the result', async () => {
    const calls: Array<{ prompt: string; system: string }> = [];
    const provider: LlmProvider = {
      name: 'openai',
      complete: async (prompt, system) => {
        calls.push({ prompt, system });
        return '  This   is   a   generated   post  ';
      }
    };

    const out = await summarizeRelease(
      { title: 'T', url: 'U', notes: 'N', charBudget: 280 },
      provider
    );

    expect(out).toBe('This is a generated post');
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('T');
    expect(calls[0].system).toContain('social media');
  });

  it('enforces the character budget even if the model overshoots', async () => {
    const provider: LlmProvider = {
      name: 'anthropic',
      complete: async () => 'word '.repeat(100)
    };
    const out = await summarizeRelease(
      { title: 'T', url: 'U', notes: 'N', charBudget: 50 },
      provider
    );
    expect(out.length).toBeLessThanOrEqual(50);
  });
});
