import {
  buildPrompt,
  clampToBudget,
  firstHighlight,
  platformCharBudget,
  summarizeRelease,
  templateSummary
} from '../src/summarizer';
import { LlmProvider } from '../src/types';

describe('platformCharBudget', () => {
  it('maps known services to their budget', () => {
    expect(platformCharBudget('twitter', 999)).toBe(280);
    expect(platformCharBudget('linkedin', 999)).toBe(700);
    expect(platformCharBudget('bluesky', 999)).toBe(300);
  });

  it('falls back for unknown or missing services', () => {
    expect(platformCharBudget('myspace', 280)).toBe(280);
    expect(platformCharBudget(null, 280)).toBe(280);
    expect(platformCharBudget(undefined, 411)).toBe(411);
  });
});

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

describe('firstHighlight', () => {
  it('skips headings/blanks and strips bullet markers', () => {
    expect(firstHighlight('# Title\n\n- Rewrote the engine\n- More')).toBe(
      'Rewrote the engine'
    );
  });

  it('strips numbered list and quote markers', () => {
    expect(firstHighlight('1. First thing')).toBe('First thing');
    expect(firstHighlight('> quoted line')).toBe('quoted line');
  });

  it('returns empty string when there is no usable line', () => {
    expect(firstHighlight('### only a heading')).toBe('');
    expect(firstHighlight('')).toBe('');
  });
});

describe('templateSummary (no-LLM fallback)', () => {
  it('builds a post from the release fields', () => {
    const out = templateSummary({
      title: 'MyLib 2.0',
      notes: '## Notes\n- Faster startup\n- New API',
      url: 'https://x.test/2',
      charBudget: 280
    });
    expect(out).toContain('MyLib 2.0 is out!');
    expect(out).toContain('Faster startup');
    expect(out).toContain('https://x.test/2');
    expect(out).toContain('#release');
  });

  it('respects the character budget', () => {
    const out = templateSummary({
      title: 'X'.repeat(100),
      notes: 'y '.repeat(100),
      url: 'https://x.test/2',
      charBudget: 80
    });
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it('works with empty notes', () => {
    const out = templateSummary({
      title: 'Tool 3.0',
      notes: '',
      url: 'https://x.test/3',
      charBudget: 280
    });
    expect(out).toContain('Tool 3.0 is out!');
    expect(out).toContain('https://x.test/3');
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
