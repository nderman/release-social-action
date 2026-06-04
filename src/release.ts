// Release-parsing logic. Pure, deterministic functions only — no network,
// no process.env, no Actions runtime. Knows nothing about LLMs or Buffer.

import { ParsedRelease, ReleaseDecision, ReleaseLike, SemVer } from './types';

// Lenient SemVer: tolerate a leading `v` and ignore pre-release/build metadata
// for the numeric extraction (those are handled separately via the flags).
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

export function parseSemVer(tag: string | null | undefined): SemVer | null {
  if (!tag) return null;
  const match = SEMVER_RE.exec(tag.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

/** A release is "major" when it is exactly `X.0.0` with `X >= 1`. */
export function isMajor(version: SemVer): boolean {
  return version.major >= 1 && version.minor === 0 && version.patch === 0;
}

export interface DecideOptions {
  /** When true (default), only major releases are posted. */
  majorOnly: boolean;
}

/**
 * Decide whether a release should generate a social post. Side-effect free:
 * the caller logs/acts on the returned decision.
 */
export function decideRelease(
  release: ReleaseLike,
  opts: DecideOptions
): ReleaseDecision {
  if (release.draft) {
    return { shouldPost: false, reason: 'Release is a draft.' };
  }
  if (release.prerelease) {
    return { shouldPost: false, reason: 'Release is a prerelease.' };
  }

  const tag = (release.tag_name ?? '').trim();
  const version = parseSemVer(tag);
  if (!version) {
    return {
      shouldPost: false,
      reason: `Tag "${tag || '(empty)'}" is not a valid SemVer.`
    };
  }

  if (opts.majorOnly && !isMajor(version)) {
    return {
      shouldPost: false,
      reason: `Tag "${tag}" is not a major (X.0.0) release.`
    };
  }

  const parsed: ParsedRelease = {
    tag,
    title: (release.name ?? '').trim() || tag,
    notes: (release.body ?? '').trim(),
    url: (release.html_url ?? '').trim(),
    version
  };

  return {
    shouldPost: true,
    reason: opts.majorOnly
      ? `Major release ${tag} detected.`
      : `Release ${tag} detected.`,
    release: parsed
  };
}
