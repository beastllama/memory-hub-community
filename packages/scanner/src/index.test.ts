import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCAN_LIMITS,
  decideReadWithinLimits,
  evaluateCanonicalPathContainment,
  evaluateWalkingSkeletonEvidencePath,
} from './index.js';

describe('walking skeleton evidence policy', () => {
  it('allows only conservative evidence filenames', () => {
    expect(evaluateWalkingSkeletonEvidencePath('docs/README.md')).toEqual({
      allowed: true,
      classification: 'C3',
    });
    expect(evaluateWalkingSkeletonEvidencePath('src/index.ts')).toEqual({
      allowed: false,
      reason: 'not_allowlisted',
    });
  });

  it('rejects traversal and mandatory excluded directories regardless of case', () => {
    expect(evaluateWalkingSkeletonEvidencePath('../README.md')).toEqual({
      allowed: false,
      reason: 'unsafe_path',
    });
    expect(evaluateWalkingSkeletonEvidencePath('Node_Modules/package.json')).toEqual({
      allowed: false,
      reason: 'excluded_segment',
    });
    expect(evaluateWalkingSkeletonEvidencePath('.git/README.md')).toEqual({
      allowed: false,
      reason: 'excluded_segment',
    });
  });
});

describe('canonical containment', () => {
  it('uses Windows case folding and component boundaries', () => {
    expect(
      evaluateCanonicalPathContainment('C:\\Work\\Repo', 'c:/work/repo/docs/README.md', 'windows')
        .contained,
    ).toBe(true);
    expect(
      evaluateCanonicalPathContainment(
        'C:\\Work\\Repo',
        'C:\\Work\\Repo-other\\README.md',
        'windows',
      ),
    ).toMatchObject({ contained: false, reason: 'outside_root' });
  });

  it('rejects UNC-like, traversal, and POSIX case-bypass paths', () => {
    expect(
      evaluateCanonicalPathContainment('C:\\Work', '\\\\server\\share\\README.md', 'windows'),
    ).toMatchObject({ contained: false, reason: 'unc_path' });
    expect(
      evaluateCanonicalPathContainment('/work/Repo', '/work/repo/README.md', 'posix'),
    ).toMatchObject({ contained: false, reason: 'outside_root' });
    expect(
      evaluateCanonicalPathContainment('/work/repo', '/work/repo/../secret', 'posix'),
    ).toMatchObject({ contained: false, reason: 'invalid_candidate' });
    expect(
      evaluateCanonicalPathContainment('/work/repo', '\\work\\repo\\README.md', 'posix'),
    ).toMatchObject({ contained: false, reason: 'invalid_candidate' });
  });
});

describe('read ceilings', () => {
  it('enforces enumeration, per-file, and aggregate limits', () => {
    expect(
      decideReadWithinLimits({
        enumeratedFileCount: 20_001,
        candidateFileBytes: 1,
        totalReadBytes: 0,
      }),
    ).toEqual({ allowed: false, reason: 'enumerated_file_limit' });
    expect(
      decideReadWithinLimits({
        enumeratedFileCount: 1,
        candidateFileBytes: DEFAULT_SCAN_LIMITS.maxFileBytes + 1,
        totalReadBytes: 0,
      }),
    ).toEqual({ allowed: false, reason: 'per_file_limit' });
    expect(
      decideReadWithinLimits({
        enumeratedFileCount: 1,
        candidateFileBytes: 2,
        totalReadBytes: DEFAULT_SCAN_LIMITS.maxTotalReadBytes - 1,
      }),
    ).toEqual({ allowed: false, reason: 'aggregate_read_limit' });
  });

  it.each([
    { enumeratedFileCount: -1, candidateFileBytes: 1, totalReadBytes: 0 },
    { enumeratedFileCount: 1.5, candidateFileBytes: 1, totalReadBytes: 0 },
    { enumeratedFileCount: 1, candidateFileBytes: Number.NaN, totalReadBytes: 0 },
    { enumeratedFileCount: 1, candidateFileBytes: 1, totalReadBytes: Number.POSITIVE_INFINITY },
  ])('fails closed for malformed counters', (input) => {
    expect(decideReadWithinLimits(input)).toEqual({ allowed: false, reason: 'invalid_input' });
  });

  it('fails closed for malformed limits and safe-integer overflow', () => {
    expect(
      decideReadWithinLimits(
        { enumeratedFileCount: 0, candidateFileBytes: 0, totalReadBytes: 0 },
        { maxEnumeratedFiles: -1, maxFileBytes: 1, maxTotalReadBytes: 1 },
      ),
    ).toEqual({ allowed: false, reason: 'invalid_limits' });
    expect(
      decideReadWithinLimits(
        {
          enumeratedFileCount: 1,
          candidateFileBytes: 1,
          totalReadBytes: Number.MAX_SAFE_INTEGER,
        },
        {
          maxEnumeratedFiles: 1,
          maxFileBytes: 1,
          maxTotalReadBytes: Number.MAX_SAFE_INTEGER,
        },
      ),
    ).toEqual({ allowed: false, reason: 'aggregate_read_limit' });
  });
});
