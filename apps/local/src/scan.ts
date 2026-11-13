import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  MANDATORY_EXCLUDED_SEGMENTS,
  evaluateCanonicalPathContainment,
  evaluateWalkingSkeletonEvidencePath,
} from '@memory-hub/scanner';
import { HubError, type Note, type Scan, type Source } from './types.js';

const excluded = new Set<string>([...MANDATORY_EXCLUDED_SEGMENTS, '.local-data', '.memory-hub']);
const MAX_ENTRIES = 20_000;
const MAX_FILE = 128 * 1024;
const MAX_TOTAL = 1024 * 1024;
const MAX_SOURCES = 16;
export const hash = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

export function containsSecret(text: string): boolean {
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|npg_[A-Za-z0-9]{10,}|AKIA[A-Z0-9]{16})\b/,
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:]+:[^\s@]+@/i,
    /["']?(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token)["']?\s*[:=]\s*["']?[^\s"',;}{]{8,}/i,
    /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\b/,
  ].some((pattern) => pattern.test(text));
}

export function contained(root: string, candidate: string): boolean {
  return evaluateCanonicalPathContainment(
    root,
    candidate,
    process.platform === 'win32' ? 'windows' : 'posix',
  ).contained;
}

/** Reject links in every existing path component, not only the final filename. */
export async function checkedPath(value: string, directory = true): Promise<string> {
  if (
    !path.isAbsolute(value) ||
    value.includes('\0') ||
    value.startsWith('\\\\') ||
    value.startsWith('//')
  ) {
    throw new HubError(
      'Choose a local folder with a full path. Network folders are not supported.',
    );
  }
  const normalized = path.resolve(value);
  let current = path.parse(normalized).root;
  for (const part of normalized.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new HubError('This path uses a link. Choose the original folder.');
  }
  const info = await lstat(normalized);
  if (directory ? !info.isDirectory() : !info.isFile()) {
    throw new HubError(
      directory
        ? 'Choose a folder, not a file.'
        : 'The source is no longer a regular file. Scan again.',
    );
  }
  return realpath(normalized);
}

export async function scanProject(input: string): Promise<Scan> {
  const root = await checkedPath(input);
  if (root === path.parse(root).root || root.toLowerCase() === homedir().toLowerCase()) {
    throw new HubError(
      'Choose one project folder. Do not choose your home folder or a whole drive.',
    );
  }
  const sources: Source[] = [];
  let skipped = 0;
  let sensitive = 0;
  let enumerated = 0;
  let bytes = 0;
  let partial = false;
  const started = Date.now();
  const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];

  while (pending.length) {
    const next = pending.shift()!;
    if (
      Date.now() - started > 15_000 ||
      enumerated >= MAX_ENTRIES ||
      sources.length >= MAX_SOURCES
    ) {
      partial = true;
      break;
    }
    try {
      const folder = await checkedPath(next.directory);
      if (!contained(root, folder))
        throw new HubError('A folder moved outside the project. Scan again.');
      const entries = [];
      const directory = await opendir(folder);
      for await (const entry of directory) {
        enumerated++;
        if (enumerated > MAX_ENTRIES) {
          partial = true;
          break;
        }
        entries.push(entry);
      }
      entries.sort(
        (a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name),
      );
      for (const entry of entries) {
        if (sources.length >= MAX_SOURCES || Date.now() - started > 15_000) {
          partial = true;
          break;
        }
        const absolute = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) {
          skipped++;
          continue;
        }
        if (entry.isDirectory()) {
          if (excluded.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) {
            skipped++;
            continue;
          }
          if (next.depth >= 5) {
            skipped++;
            partial = true;
            continue;
          }
          pending.push({ directory: absolute, depth: next.depth + 1 });
          continue;
        }
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        if (
          !entry.isFile() ||
          !evaluateWalkingSkeletonEvidencePath(relative).allowed ||
          /(?:lock|\.lockb)$/i.test(entry.name)
        ) {
          skipped++;
          continue;
        }
        const canonical = await checkedPath(absolute, false);
        if (!contained(root, canonical))
          throw new HubError('A source moved outside the project. Scan again.');
        const before = await lstat(canonical);
        if (before.size > MAX_FILE || bytes + before.size > MAX_TOTAL) {
          skipped++;
          partial = true;
          continue;
        }
        const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let text: string;
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
            throw new HubError('A source changed during the scan. Scan again.');
          const buffer = Buffer.alloc(MAX_FILE + 1);
          const result = await handle.read(buffer, 0, buffer.length, 0);
          bytes += result.bytesRead;
          if (result.bytesRead > MAX_FILE || bytes > MAX_TOTAL) {
            skipped++;
            partial = true;
            continue;
          }
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(
              buffer.subarray(0, result.bytesRead),
            );
          } catch {
            skipped++;
            continue;
          }
          if (text.includes('\0')) {
            skipped++;
            continue;
          }
          const after = await handle.stat();
          if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
            throw new HubError('A source changed during the scan. Scan again.');
        } finally {
          await handle.close();
        }
        if (containsSecret(text) || containsSecret(relative)) {
          sensitive++;
          skipped++;
          continue;
        }
        sources.push({
          id: hash(relative).slice(0, 16),
          path: relative,
          hash: hash(text),
          text: text.slice(0, 6000),
        });
      }
    } catch (error) {
      if (error instanceof HubError) throw error;
      if (next.directory === root)
        throw new HubError('This folder cannot be read. Choose a folder you can open.');
      skipped++;
      partial = true;
    }
  }
  sources.sort((a, b) => a.path.localeCompare(b.path));
  const notes = sources.flatMap(notesFromSource).slice(0, 30);
  return {
    id: hash(JSON.stringify(sources.map((source) => [source.path, source.hash]))),
    at: new Date().toISOString(),
    root,
    sources,
    notes,
    skipped,
    sensitive,
    partial,
  };
}

function notesFromSource(source: Source): Note[] {
  const lines = source.text.split(/\r?\n/);
  if (/package\.json$/i.test(source.path)) {
    try {
      const manifest = JSON.parse(source.text) as Record<string, unknown>;
      return ['name', 'description', 'version'].flatMap((key) => {
        const value = manifest[key];
        if (typeof value !== 'string' || value.length > 500 || !value.trim()) return [];
        const quote = lines.find(
          (line) => line.includes(`"${key}"`) && line.includes(JSON.stringify(value)),
        );
        if (!quote || quote.length > 1500) return [];
        return [
          {
            id: hash(source.id + key).slice(0, 16),
            text: `${key[0]!.toUpperCase()}${key.slice(1)}: ${value}`,
            sourceId: source.id,
            quote: quote.trim(),
            kind: 'source' as const,
          },
        ];
      });
    } catch {
      return [];
    }
  }
  if (/readme(?:\.(?:md|txt|markdown|mdx))?$/i.test(source.path)) {
    let fenced = false;
    const paragraphs: string[] = [];
    for (const line of lines) {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        continue;
      }
      const clean = line.trim();
      if (!fenced && clean.length >= 30 && clean.length <= 700 && !/^[#<>!|\[\-*`]/.test(clean))
        paragraphs.push(clean);
      if (paragraphs.length === 2) break;
    }
    return paragraphs.map((quote, index) => ({
      id: hash(source.id + index).slice(0, 16),
      text: quote,
      quote,
      sourceId: source.id,
      kind: 'source',
    }));
  }
  return [];
}
