import { decideRelease, isMajor, parseSemVer } from '../src/release';

describe('parseSemVer', () => {
  it('parses a plain version', () => {
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
  });

  it('tolerates a leading v', () => {
    expect(parseSemVer('v2.0.0')).toEqual({ major: 2, minor: 0, patch: 0 });
  });

  it('ignores pre-release/build metadata', () => {
    expect(parseSemVer('v3.0.0-rc.1')).toEqual({ major: 3, minor: 0, patch: 0 });
    expect(parseSemVer('1.0.0+build.5')).toEqual({ major: 1, minor: 0, patch: 0 });
  });

  it('returns null for malformed tags', () => {
    expect(parseSemVer('not-a-version')).toBeNull();
    expect(parseSemVer('1.2')).toBeNull();
    expect(parseSemVer('')).toBeNull();
    expect(parseSemVer(null)).toBeNull();
    expect(parseSemVer(undefined)).toBeNull();
  });
});

describe('isMajor', () => {
  it('is true only for X.0.0 with X>=1', () => {
    expect(isMajor({ major: 1, minor: 0, patch: 0 })).toBe(true);
    expect(isMajor({ major: 5, minor: 0, patch: 0 })).toBe(true);
  });

  it('is false for minor/patch bumps and 0.x', () => {
    expect(isMajor({ major: 1, minor: 2, patch: 0 })).toBe(false);
    expect(isMajor({ major: 1, minor: 0, patch: 4 })).toBe(false);
    expect(isMajor({ major: 0, minor: 0, patch: 0 })).toBe(false);
  });
});

describe('decideRelease', () => {
  const base = {
    tag_name: 'v2.0.0',
    name: 'Big Release',
    body: 'Notes here',
    html_url: 'https://example.com/r/2.0.0',
    draft: false,
    prerelease: false
  };

  it('posts on a major release when majorOnly=true', () => {
    const d = decideRelease(base, { majorOnly: true });
    expect(d.shouldPost).toBe(true);
    expect(d.release).toMatchObject({
      tag: 'v2.0.0',
      title: 'Big Release',
      notes: 'Notes here',
      url: 'https://example.com/r/2.0.0'
    });
  });

  it('skips a minor release when majorOnly=true', () => {
    const d = decideRelease({ ...base, tag_name: 'v2.1.0' }, { majorOnly: true });
    expect(d.shouldPost).toBe(false);
    expect(d.reason).toMatch(/not a major/);
  });

  it('posts a minor release when majorOnly=false', () => {
    const d = decideRelease({ ...base, tag_name: 'v2.1.0' }, { majorOnly: false });
    expect(d.shouldPost).toBe(true);
  });

  it('skips drafts and prereleases', () => {
    expect(decideRelease({ ...base, draft: true }, { majorOnly: true }).shouldPost).toBe(false);
    expect(decideRelease({ ...base, prerelease: true }, { majorOnly: true }).shouldPost).toBe(false);
  });

  it('skips malformed tags', () => {
    const d = decideRelease({ ...base, tag_name: 'release-foo' }, { majorOnly: true });
    expect(d.shouldPost).toBe(false);
    expect(d.reason).toMatch(/not a valid SemVer/);
  });

  it('falls back to tag for title when name is empty', () => {
    const d = decideRelease({ ...base, name: '' }, { majorOnly: true });
    expect(d.release?.title).toBe('v2.0.0');
  });
});
