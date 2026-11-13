export type PathPlatform = 'windows' | 'posix';

export const MANDATORY_EXCLUDED_SEGMENTS = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  '.cache',
  'cache',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  'generated',
] as const;

const EXCLUDED_SEGMENT_SET: ReadonlySet<string> = new Set(MANDATORY_EXCLUDED_SEGMENTS);

export const WALKING_SKELETON_EVIDENCE_FILENAMES = [
  'readme',
  'readme.md',
  'readme.markdown',
  'readme.mdx',
  'readme.txt',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'composer.json',
  'pyproject.toml',
  'requirements.txt',
  'cargo.toml',
  'go.mod',
  'gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'tsconfig.json',
] as const;

const EVIDENCE_FILENAME_SET: ReadonlySet<string> = new Set(WALKING_SKELETON_EVIDENCE_FILENAMES);

export type FilePolicyDecision =
  | { readonly allowed: true; readonly classification: 'C3' }
  | {
      readonly allowed: false;
      readonly reason: 'excluded_segment' | 'not_allowlisted' | 'unsafe_path';
    };

export function evaluateWalkingSkeletonEvidencePath(relativePath: string): FilePolicyDecision {
  if (!isSafeRelativePath(relativePath)) return { allowed: false, reason: 'unsafe_path' };
  const segments = relativePath.split('/');
  if (segments.slice(0, -1).some((segment) => EXCLUDED_SEGMENT_SET.has(segment.toLowerCase()))) {
    return { allowed: false, reason: 'excluded_segment' };
  }
  const filename = segments.at(-1)?.toLowerCase();
  if (!filename || !EVIDENCE_FILENAME_SET.has(filename))
    return { allowed: false, reason: 'not_allowlisted' };
  return { allowed: true, classification: 'C3' };
}

function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\')) return false;
  if (relativePath.startsWith('/') || /^[a-zA-Z]:/.test(relativePath)) return false;
  return relativePath.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

export type ContainmentDecision =
  | {
      readonly contained: true;
      readonly normalizedRoot: string;
      readonly normalizedCandidate: string;
    }
  | {
      readonly contained: false;
      readonly reason: 'invalid_root' | 'invalid_candidate' | 'unc_path' | 'outside_root';
    };

/**
 * Checks already-canonical absolute paths. It does not resolve filesystem links;
 * callers must resolve real paths before passing them here. Ambiguity fails closed.
 */
export function evaluateCanonicalPathContainment(
  root: string,
  candidate: string,
  platform: PathPlatform,
): ContainmentDecision {
  const rootResult = normalizeCanonicalAbsolutePath(root, platform);
  if (!rootResult.ok)
    return {
      contained: false,
      reason: rootResult.reason === 'unc_path' ? 'unc_path' : 'invalid_root',
    };
  const candidateResult = normalizeCanonicalAbsolutePath(candidate, platform);
  if (!candidateResult.ok) {
    return {
      contained: false,
      reason: candidateResult.reason === 'unc_path' ? 'unc_path' : 'invalid_candidate',
    };
  }

  const comparisonRoot = platform === 'windows' ? rootResult.path.toLowerCase() : rootResult.path;
  const comparisonCandidate =
    platform === 'windows' ? candidateResult.path.toLowerCase() : candidateResult.path;
  const rootPrefix =
    comparisonRoot === '/' || /^[a-z]:\/$/.test(comparisonRoot)
      ? comparisonRoot
      : `${comparisonRoot}/`;

  if (comparisonCandidate !== comparisonRoot && !comparisonCandidate.startsWith(rootPrefix)) {
    return { contained: false, reason: 'outside_root' };
  }
  return {
    contained: true,
    normalizedRoot: rootResult.path,
    normalizedCandidate: candidateResult.path,
  };
}

type NormalizedAbsolutePath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'invalid' | 'unc_path' };

function normalizeCanonicalAbsolutePath(
  value: string,
  platform: PathPlatform,
): NormalizedAbsolutePath {
  if (!value || value.includes('\0') || value.startsWith('//') || value.startsWith('\\\\')) {
    return {
      ok: false,
      reason: value.startsWith('//') || value.startsWith('\\\\') ? 'unc_path' : 'invalid',
    };
  }
  if (platform === 'posix' && value.includes('\\')) return { ok: false, reason: 'invalid' };
  const unified = value.replaceAll('\\', '/');
  if (unified.includes('//')) return { ok: false, reason: 'unc_path' };
  const segments = unified.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..'))
    return { ok: false, reason: 'invalid' };

  if (platform === 'windows') {
    if (!/^[a-zA-Z]:\//.test(unified)) return { ok: false, reason: 'invalid' };
    if (/^[a-zA-Z]:\/+$/.test(unified)) return { ok: true, path: `${unified.slice(0, 2)}/` };
    const normalized = unified.replace(/\/+$/, '');
    return { ok: true, path: normalized };
  }
  if (!unified.startsWith('/') || /^[a-zA-Z]:\//.test(unified))
    return { ok: false, reason: 'invalid' };
  return { ok: true, path: unified === '/' ? unified : unified.replace(/\/+$/, '') };
}

export const DEFAULT_SCAN_LIMITS = {
  maxEnumeratedFiles: 20_000,
  maxFileBytes: 1_024 * 1_024,
  maxTotalReadBytes: 100 * 1_024 * 1_024,
} as const;

export interface ScanLimits {
  readonly maxEnumeratedFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalReadBytes: number;
}

export interface ReadLimitInput {
  readonly enumeratedFileCount: number;
  readonly candidateFileBytes: number;
  readonly totalReadBytes: number;
}

export type ReadLimitDecision =
  | { readonly allowed: true; readonly nextTotalReadBytes: number }
  | {
      readonly allowed: false;
      readonly reason:
        | 'invalid_input'
        | 'invalid_limits'
        | 'enumerated_file_limit'
        | 'per_file_limit'
        | 'aggregate_read_limit';
    };

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function decideReadWithinLimits(
  input: ReadLimitInput,
  limits: ScanLimits = DEFAULT_SCAN_LIMITS,
): ReadLimitDecision {
  if (
    !isNonnegativeSafeInteger(input.enumeratedFileCount) ||
    !isNonnegativeSafeInteger(input.candidateFileBytes) ||
    !isNonnegativeSafeInteger(input.totalReadBytes)
  ) {
    return { allowed: false, reason: 'invalid_input' };
  }
  if (
    !isNonnegativeSafeInteger(limits.maxEnumeratedFiles) ||
    !isNonnegativeSafeInteger(limits.maxFileBytes) ||
    !isNonnegativeSafeInteger(limits.maxTotalReadBytes)
  ) {
    return { allowed: false, reason: 'invalid_limits' };
  }
  if (input.enumeratedFileCount > limits.maxEnumeratedFiles) {
    return { allowed: false, reason: 'enumerated_file_limit' };
  }
  if (input.candidateFileBytes > limits.maxFileBytes)
    return { allowed: false, reason: 'per_file_limit' };
  if (
    input.totalReadBytes > limits.maxTotalReadBytes ||
    input.candidateFileBytes > limits.maxTotalReadBytes - input.totalReadBytes
  ) {
    return { allowed: false, reason: 'aggregate_read_limit' };
  }
  return { allowed: true, nextTotalReadBytes: input.totalReadBytes + input.candidateFileBytes };
}
