import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { get as httpGet } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalHub, parseSuggestions, renderNote } from './hub.js';
import { checkedPath, containsSecret, hash, scanProject } from './scan.js';
import { startLocalServer } from './server.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'memory-hub-test-'));
  const project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(
    path.join(project, 'README.md'),
    '# Test project\n\nThis project keeps useful notes in ordinary Markdown files.\n',
  );
  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify(
      { name: 'test-project', description: 'A local notes project.', version: '1.0.0' },
      null,
      2,
    ),
  );
  const hub = await LocalHub.load(path.join(root, 'data'));
  await hub.change(() => hub.add(project));
  return { root, project, hub };
}

describe('bounded local scanner', () => {
  it('finds source facts without running project code', async () => {
    const { project } = await fixture();
    await writeFile(path.join(project, 'index.js'), 'throw new Error("Do not execute")');
    const scan = await scanProject(project);
    expect(scan.sources.map((source) => source.path)).toEqual(['package.json', 'README.md']);
    expect(scan.notes).toHaveLength(4);
    expect(
      scan.notes.every((note) =>
        scan.sources.find((source) => source.id === note.sourceId)?.text.includes(note.quote),
      ),
    ).toBe(true);
  });

  it('excludes secret files, dependency folders, and binary content', async () => {
    const { project } = await fixture();
    await mkdir(path.join(project, 'node_modules'));
    await writeFile(
      path.join(project, 'node_modules', 'README.md'),
      'Never read this dependency content.',
    );
    await writeFile(path.join(project, '.env'), 'password=this-is-a-test-password');
    await writeFile(path.join(project, 'README.txt'), 'api_key="this-is-a-fake-secret-token"');
    await writeFile(path.join(project, 'README.mdx'), Buffer.from([0xff, 0x00, 0xfe]));
    const scan = await scanProject(project);
    expect(scan.sensitive).toBe(1);
    expect(scan.sources).toHaveLength(2);
    expect(JSON.stringify(scan)).not.toContain('fake-secret');
    expect(JSON.stringify(scan)).not.toContain('Never read');
  });

  it('reports limits without reading oversized evidence', async () => {
    const { project } = await fixture();
    await writeFile(path.join(project, 'README.txt'), 'x'.repeat(128 * 1024 + 1));
    const scan = await scanProject(project);
    expect(scan.partial).toBe(true);
    expect(scan.sources.map((source) => source.path)).not.toContain('README.txt');
  });

  it('rejects relative, network, and linked roots', async () => {
    const { root, project } = await fixture();
    await expect(checkedPath('../project')).rejects.toThrow('full path');
    await expect(checkedPath('\\\\server\\share')).rejects.toThrow('Network folders');
    await symlink(
      project,
      path.join(root, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(scanProject(path.join(root, 'link'))).rejects.toThrow('uses a link');
  });

  it('skips linked children instead of reading outside the approved root', async () => {
    const { root, project } = await fixture();
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(
      path.join(outside, 'README.md'),
      'This outside content must never appear in project evidence.',
    );
    await symlink(
      outside,
      path.join(project, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(JSON.stringify(await scanProject(project))).not.toContain('outside content');
  });

  it('detects common credential forms without returning the values', () => {
    expect(containsSecret('postgresql://owner:example-password@database.test/db')).toBe(true);
    expect(containsSecret('ghp_' + 'x'.repeat(30))).toBe(true);
    expect(containsSecret('-----BEGIN PRIVATE KEY-----')).toBe(true);
    expect(containsSecret('Keep ordinary Markdown notes.')).toBe(false);
  });
});

describe('review and save', () => {
  it('accepts 50 projects and rejects the next one without losing state', async () => {
    const { root, hub } = await fixture();
    for (let index = 1; index < 51; index++) {
      const folder = path.join(root, `project-${index}`);
      await mkdir(folder);
      await writeFile(
        path.join(folder, 'README.md'),
        'This small project keeps its notes in Markdown files.',
      );
      if (index < 50) await hub.change(() => hub.add(folder));
      else await expect(hub.change(() => hub.add(folder))).rejects.toThrow('50 projects');
    }
    expect(hub.view().projects).toHaveLength(50);
    const selectedId = hub.view().project!.id;
    for (const project of hub.view().projects) {
      expect(await hub.change(() => hub.rescan(project.id))).toEqual({ changed: false });
    }
    expect(hub.view().project!.id).toBe(selectedId);
    const restored = await LocalHub.load(path.join(root, 'data'));
    expect(restored.view().projects).toHaveLength(50);
    expect(restored.view().project!.id).toBe(selectedId);
  });

  it('persists the current project and selection across restart', async () => {
    const { root, hub } = await fixture();
    const project = hub.view().project!;
    await hub.change(async () => hub.review(project.id, project.scan.id, [project.notes[0]!.id]));
    const restored = await LocalHub.load(path.join(root, 'data'));
    expect(restored.view().project?.id).toBe(project.id);
    expect(restored.view().project?.selected).toEqual([project.notes[0]!.id]);
    expect(restored.view().markdown).toBe(hub.view().markdown);
  });

  it('writes reviewed notes once and recovers after restart', async () => {
    const { root, hub } = await fixture();
    const project = hub.view().project!;
    await hub.change(async () => hub.review(project.id, project.scan.id, [project.notes[0]!.id]));
    const saved = await hub.change(() => hub.save(project.id, project.scan.id));
    expect(saved.unchanged).toBe(false);
    expect(await readFile(saved.path, 'utf8')).toBe(hub.view().markdown);
    const restored = await LocalHub.load(path.join(root, 'data'));
    expect(
      (await restored.change(() => restored.save(project.id, project.scan.id))).unchanged,
    ).toBe(true);
    expect(await readdir(path.dirname(saved.path))).toHaveLength(1);
    expect(restored.view().isSaved).toBe(true);
  });

  it('detects changed sources before writing', async () => {
    const { project: folder, hub } = await fixture();
    const project = hub.view().project!;
    await writeFile(
      path.join(folder, 'README.md'),
      'This project has new facts that require a fresh review.',
    );
    await expect(hub.change(() => hub.save(project.id, project.scan.id))).rejects.toThrow(
      'Project files changed',
    );
    expect(hub.view().project?.savedPath).toBeNull();
  });

  it('keeps external edits and rejects an export conflict', async () => {
    const { hub } = await fixture();
    const project = hub.view().project!;
    const saved = await hub.change(() => hub.save(project.id, project.scan.id));
    await writeFile(saved.path, 'An owner edit that must stay intact.');
    await expect(hub.change(() => hub.save(project.id, project.scan.id))).rejects.toThrow(
      'Nothing was overwritten',
    );
    expect(await readFile(saved.path, 'utf8')).toBe('An owner edit that must stay intact.');
  });

  it('rejects links at the output boundary', async () => {
    const { root, hub } = await fixture();
    const project = hub.view().project!;
    const destination = path.join(root, 'vault');
    const outside = path.join(root, 'outside');
    await mkdir(destination);
    await mkdir(outside);
    await symlink(
      outside,
      path.join(destination, 'Memory Hub'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await hub.change(() => hub.destination(destination));
    await expect(hub.change(() => hub.save(project.id, project.scan.id))).rejects.toThrow(
      'uses a link',
    );
    expect(await readdir(outside)).toHaveLength(0);
  });

  it('rejects a stale review and empty selection', async () => {
    const { hub } = await fixture();
    const project = hub.view().project!;
    expect(() => hub.review(project.id, 'stale', [])).toThrow('out of date');
    await hub.change(async () => hub.review(project.id, project.scan.id, []));
    await expect(hub.change(() => hub.save(project.id, project.scan.id))).rejects.toThrow(
      'Select at least one',
    );
    expect(() => hub.review(project.id, project.scan.id, ['not-a-note'])).toThrow(
      'no longer available',
    );
  });

  it('cannot save new AI notes under an older preview approval', async () => {
    const { hub } = await fixture();
    const project = hub.view().project!;
    const previousReview = hub.view().reviewHash!;
    const source = project.scan.sources.find((item) => item.path === 'README.md')!;
    const raw = JSON.stringify({
      notes: [
        {
          text: 'The project uses Markdown notes.',
          sourceId: source.id,
          quote: 'This project keeps useful notes in ordinary Markdown files.',
        },
      ],
    });
    await hub.change(async () => hub.import(project.id, project.scan.id, raw));
    await expect(
      hub.change(() => hub.save(project.id, project.scan.id, previousReview)),
    ).rejects.toThrow('changed after this preview');
    expect(hub.view().project!.savedPath).toBeNull();
  });

  it('retains selected notes on an unchanged rescan', async () => {
    const { hub, project: folder } = await fixture();
    const project = hub.view().project!;
    await hub.change(async () => hub.review(project.id, project.scan.id, [project.notes[0]!.id]));
    await hub.change(() => hub.add(folder));
    expect(hub.view().projects).toHaveLength(1);
    expect(hub.view().project!.selected).toHaveLength(1);
  });

  it('does not save under a preview that showed a different memory folder', async () => {
    const { hub, root } = await fixture();
    const project = hub.view().project!;
    const previousReview = hub.view().reviewHash!;
    const otherFolder = path.join(root, 'other memory');
    await mkdir(otherFolder);
    await hub.change(() => hub.destination(otherFolder));
    await expect(
      hub.change(() => hub.save(project.id, project.scan.id, previousReview)),
    ).rejects.toThrow('memory folder changed');
    expect(await readdir(otherFolder)).toEqual([]);
    const currentReview = hub.view().reviewHash!;
    const saved = await hub.change(() => hub.save(project.id, project.scan.id, currentReview));
    expect(path.dirname(saved.path)).toBe(path.join(otherFolder, 'Memory Hub'));
  });

  it('retains unchanged AI notes, reviewed selections, and saved exports after a rescan', async () => {
    const { root, hub } = await fixture();
    const project = hub.view().project!;
    const source = project.scan.sources.find((item) => item.path === 'README.md')!;
    await hub.change(async () =>
      hub.import(
        project.id,
        project.scan.id,
        JSON.stringify({
          notes: [
            {
              text: 'The project uses Markdown notes.',
              sourceId: source.id,
              quote: 'This project keeps useful notes in ordinary Markdown files.',
            },
          ],
        }),
      ),
    );
    const aiNote = project.notes.find((note) => note.kind === 'ai')!;
    await hub.change(async () =>
      hub.review(project.id, project.scan.id, [project.notes[0]!.id, aiNote.id]),
    );
    const saved = await hub.change(() => hub.save(project.id, project.scan.id));
    const before = structuredClone(hub.view().project!);
    const markdown = hub.view().markdown;

    expect(await hub.change(() => hub.rescan(project.id))).toEqual({ changed: false });
    const current = hub.view().project!;
    expect(current.notes).toEqual(before.notes);
    expect(current.selected).toEqual(before.selected);
    expect(current.scan.id).toBe(before.scan.id);
    expect(current.savedPath).toBe(before.savedPath);
    expect(current.savedHash).toBe(before.savedHash);
    expect(hub.view().markdown).toBe(markdown);
    expect(hub.view().isSaved).toBe(true);
    expect(await readFile(saved.path, 'utf8')).toBe(markdown);
    expect(await readdir(path.dirname(saved.path))).toHaveLength(1);

    const restored = await LocalHub.load(path.join(root, 'data'));
    expect(restored.view().project!.notes).toEqual(before.notes);
    expect(restored.view().project!.selected).toEqual(before.selected);
    expect(restored.view().project!.id).toBe(before.id);
    expect(restored.view().markdown).toBe(markdown);
    expect(restored.view().isSaved).toBe(true);
  });

  it('requires a new review after changed evidence without changing previous exports', async () => {
    const { root, project: folder, hub } = await fixture();
    const before = structuredClone(hub.view().project!);
    const saved = await hub.change(() => hub.save(before.id, before.scan.id));
    const exported = await readFile(saved.path, 'utf8');
    const savedHash = hub.view().project!.savedHash;
    const changedText = 'This project now keeps its updated notes in plain Markdown files.\n';
    await writeFile(path.join(folder, 'README.md'), changedText);

    expect(await hub.change(() => hub.rescan(before.id))).toEqual({ changed: true });
    const current = hub.view().project!;
    expect(current.id).toBe(before.id);
    expect(current.scan.id).not.toBe(before.scan.id);
    expect(current.notes).toEqual(current.scan.notes);
    expect(current.notes.some((note) => note.text === changedText.trim())).toBe(true);
    expect(current.selected).toEqual([]);
    expect(current.savedPath).toBe(saved.path);
    expect(current.savedHash).toBe(savedHash);
    expect(hub.view().isSaved).toBe(false);
    expect(await readFile(saved.path, 'utf8')).toBe(exported);
    expect(await readdir(path.dirname(saved.path))).toHaveLength(1);
    expect(await readFile(path.join(folder, 'README.md'), 'utf8')).toBe(changedText);
    expect(() => hub.review(before.id, before.scan.id, [])).toThrow('out of date');
    await expect(hub.change(() => hub.save(current.id, current.scan.id))).rejects.toThrow(
      'Select at least one',
    );

    expect(await hub.change(() => hub.rescan(before.id))).toEqual({ changed: false });
    expect(hub.view().project!.selected).toEqual([]);
    const restored = await LocalHub.load(path.join(root, 'data'));
    expect(restored.view().project!.selected).toEqual([]);
    expect(restored.view().project!.savedPath).toBe(saved.path);
    expect(restored.view().isSaved).toBe(false);
  });

  it('continues independent rescans after a missing project and preserves the current project', async () => {
    const { root, hub } = await fixture();
    for (const name of ['second', 'third']) {
      const folder = path.join(root, name);
      await mkdir(folder);
      await writeFile(
        path.join(folder, 'README.md'),
        'This project keeps its local notes in Markdown.',
      );
      await hub.change(() => hub.add(folder));
    }
    const projects = hub.view().projects;
    const first = projects[0]!;
    const second = projects[1]!;
    const third = projects[2]!;
    await hub.change(async () => hub.select(first.id));
    const failedBefore = structuredClone(hub.project(second.id));
    await rename(second.root, path.join(root, 'moved-second'));
    for (const project of [first, third]) {
      await writeFile(
        path.join(project.root, 'README.md'),
        'This project has updated local evidence that needs a fresh review.\n',
      );
    }

    const checked: string[] = [];
    const failures: string[] = [];
    for (const project of projects) {
      try {
        expect(await hub.change(() => hub.rescan(project.id))).toEqual({ changed: true });
        checked.push(project.id);
      } catch {
        failures.push(project.id);
      }
    }
    expect(checked).toEqual([first.id, third.id]);
    expect(failures).toEqual([second.id]);
    expect(hub.project(second.id)).toEqual(failedBefore);
    expect(hub.project(first.id).selected).toEqual([]);
    expect(hub.project(third.id).selected).toEqual([]);
    expect(hub.view().project!.id).toBe(first.id);
    expect(await readdir(path.join(root, 'data'))).toEqual(['state.json']);

    const restored = await LocalHub.load(path.join(root, 'data'));
    expect(restored.view().project!.id).toBe(first.id);
    expect(restored.project(second.id)).toEqual(failedBefore);
    expect(restored.project(first.id).scan.id).toBe(hub.project(first.id).scan.id);
    expect(restored.project(third.id).scan.id).toBe(hub.project(third.id).scan.id);
  });

  it('rejects unregistered rescan IDs without changing memory or persisted state', async () => {
    const { root, hub } = await fixture();
    const before = structuredClone(hub.view());
    const stateFile = path.join(root, 'data', 'state.json');
    const persisted = await readFile(stateFile, 'utf8');
    await expect(hub.change(() => hub.rescan('unknown'))).rejects.toMatchObject({ status: 404 });
    expect(hub.view()).toEqual(before);
    expect(await readFile(stateFile, 'utf8')).toBe(persisted);
  });

  it('requires a save to the current destination', async () => {
    const { root, hub } = await fixture();
    const project = hub.view().project!;
    const first = await hub.change(() => hub.save(project.id, project.scan.id));
    const destination = path.join(root, 'second-vault');
    await mkdir(destination);
    await hub.change(() => hub.destination(destination));
    expect(hub.view().isSaved).toBe(false);
    expect(hub.view().projects[0]!.isSaved).toBe(false);
    expect(hub.view().project!.savedPath).toBe(first.path);
    expect(await readdir(destination)).toEqual([]);
    const second = await hub.change(() => hub.save(project.id, project.scan.id));
    expect(path.dirname(second.path)).toBe(path.join(destination, 'Memory Hub'));
    expect(hub.view().isSaved).toBe(true);
  });

  it('does not mark new content as saved', async () => {
    const { hub } = await fixture();
    const project = hub.view().project!;
    await hub.change(() => hub.save(project.id, project.scan.id));
    expect(hub.view().isSaved).toBe(true);
    await hub.change(async () => hub.review(project.id, project.scan.id, [project.notes[0]!.id]));
    expect(hub.view().isSaved).toBe(false);
    expect(hub.view().projects[0]!.isSaved).toBe(false);
  });

  it('serializes writes and restores state on failure', async () => {
    const { hub } = await fixture();
    const before = hub.view().destination;
    let release!: () => void;
    const pending = hub.change(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(hub.change(async () => undefined)).rejects.toThrow('still running');
    release();
    await pending;
    await expect(
      hub.change(async () => {
        await hub.destination('relative');
      }),
    ).rejects.toThrow();
    expect(hub.view().destination).toBe(before);
  });

  it('preserves corrupt state instead of silently replacing it', async () => {
    const { root } = await fixture();
    const file = path.join(root, 'data', 'state.json');
    await writeFile(file, '{invalid');
    await expect(LocalHub.load(path.join(root, 'data'))).rejects.toThrow('Keep state.json');
    expect(await readFile(file, 'utf8')).toBe('{invalid');
  });
});

describe('bring your own AI bridge', () => {
  it("keeps the owner's excluded source notes excluded during an AI import", async () => {
    const { hub } = await fixture();
    const project = hub.view().project!;
    const source = project.scan.sources.find((item) => item.path === 'README.md')!;
    const kept = project.notes[0]!.id;
    await hub.change(async () => hub.review(project.id, project.scan.id, [kept]));
    const raw = JSON.stringify({
      notes: [
        {
          text: 'The project uses Markdown notes.',
          sourceId: source.id,
          quote: 'This project keeps useful notes in ordinary Markdown files.',
        },
      ],
    });
    await hub.change(async () => hub.import(project.id, project.scan.id, raw));
    const next = hub.view().project!;
    expect(next.selected).toHaveLength(2);
    expect(next.selected).toContain(kept);
  });

  it('accepts a fenced reply with an exact quote and marks it as a draft', async () => {
    const { hub } = await fixture();
    const project = hub.view().project!;
    const source = project.scan.sources.find((item) => item.path === 'README.md')!;
    const raw = JSON.stringify({
      notes: [
        {
          text: 'The project uses Markdown notes.',
          sourceId: source.id,
          quote: 'This project keeps useful notes in ordinary Markdown files.',
        },
      ],
    });
    const notes = parseSuggestions('```json\n' + raw + '\n```', project);
    expect(notes[0]?.kind).toBe('ai');
    await hub.change(async () => hub.import(project.id, project.scan.id, raw));
    expect(hub.view().project!.notes).toHaveLength(5);
    expect(hub.view().markdown).toContain('## AI draft');
  });

  it('rejects unsupported citations, invalid JSON, and secrets', async () => {
    const { hub } = await fixture();
    const project = hub.view().project!;
    expect(() => parseSuggestions('not JSON', project)).toThrow('not valid JSON');
    expect(() =>
      parseSuggestions(
        JSON.stringify({
          notes: [
            { text: 'Invented claim', sourceId: 'unknown', quote: 'No matching evidence here.' },
          ],
        }),
        project,
      ),
    ).toThrow('no matching source');
    expect(() => parseSuggestions('password="this-is-a-fake-secret"', project)).toThrow(
      'may contain a secret',
    );
    expect(() => parseSuggestions(JSON.stringify({ notes: [] }), project)).toThrow('1 to 10');
  });

  it('escapes active Markdown and HTML in note exports', async () => {
    const { hub } = await fixture();
    const project = structuredClone(hub.view().project!);
    project.notes[0]!.text = '<script>alert(1)</script> [link](https://example.test)';
    const output = renderNote(project);
    expect(output).not.toContain('<script>');
    expect(output).not.toContain('[link](');
  });

  it('builds a bounded prompt from known sources without a provider key', async () => {
    const { hub } = await fixture();
    const project = hub.view().project!;
    const prompt = hub.prompt(project.id, project.scan.id);
    expect(prompt).toContain('Do not run code or tools');
    expect(prompt).toContain(project.scan.sources[0]!.id);
    expect(prompt).not.toContain(project.root);
    expect(prompt.length).toBeLessThan(100_000);
  });

  it('automatically bounds multilingual evidence without breaking source quotes', async () => {
    const { hub, project: folder } = await fixture();
    for (let index = 0; index < 14; index++) {
      const directory = path.join(folder, `docs-${index}`);
      await mkdir(directory);
      await writeFile(path.join(directory, 'README.md'), '文'.repeat(6000));
    }
    await hub.change(() => hub.add(folder));
    const project = hub.view().project!;
    expect(project.scan.sources).toHaveLength(16);
    const prompt = hub.prompt(project.id, project.scan.id);
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThan(100_000);
    const evidence = JSON.parse(prompt.split('Evidence follows as JSON:\n\n')[1]!) as Array<{
      sourceId: string;
      text: string;
    }>;
    expect(evidence).toHaveLength(16);
    for (const source of evidence) {
      expect(
        project.scan.sources
          .find((item) => item.id === source.sourceId)!
          .text.startsWith(source.text),
      ).toBe(true);
      expect(source.text).not.toContain('\uFFFD');
    }
  });
});

describe('loopback API boundary', () => {
  const running: Awaited<ReturnType<typeof startLocalServer>>[] = [];
  afterEach(async () => {
    for (const app of running.splice(0)) {
      app.server.closeAllConnections();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
    }
  });
  async function app() {
    const directory = await mkdtemp(path.join(tmpdir(), 'memory-hub-api-'));
    const instance = await startLocalServer(directory, { picker: async () => null });
    running.push(instance);
    return instance;
  }

  it('requires the random session token even on local reads', async () => {
    const instance = await app();
    expect((await fetch(`${instance.origin}/api/state`)).status).toBe(401);
    const result = await fetch(`${instance.origin}/api/state`, {
      headers: { Authorization: `Bearer ${instance.token}` },
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ projects: [], project: null });
  });

  it('rejects foreign origins and DNS-rebinding hostnames', async () => {
    const instance = await app();
    const headers = { Authorization: `Bearer ${instance.token}` };
    expect(
      (
        await fetch(`${instance.origin}/api/state`, {
          headers: { ...headers, Origin: 'https://evil.example' },
        })
      ).status,
    ).toBe(403);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      httpGet(
        `${instance.origin}/api/state`,
        { headers: { ...headers, Host: 'evil.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on('error', reject);
    });
    expect(status).toBe(403);
  });

  it('rejects incorrect content types and malformed requests', async () => {
    const instance = await app();
    const headers = { Authorization: `Bearer ${instance.token}` };
    expect(
      (await fetch(`${instance.origin}/api/pick`, { method: 'POST', headers, body: '{}' })).status,
    ).toBe(415);
    expect(
      (
        await fetch(`${instance.origin}/api/pick`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: '{no',
        })
      ).status,
    ).toBe(400);
  });

  it('treats a canceled folder picker as a non-destructive action', async () => {
    const instance = await app();
    const result = await fetch(`${instance.origin}/api/pick`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ path: null });
  });

  it('requires an explicit manual-share decision for prompt export', async () => {
    const instance = await app();
    const response = await fetch(`${instance.origin}/api/prompt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'unknown', scanId: 'unknown' }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Confirm') });
  });

  it('never invokes an AI without an explicit analysis decision', async () => {
    const { root } = await fixture();
    const run = vi.fn();
    const instance = await startLocalServer(path.join(root, 'api-data'), {
      gateway: { inspect: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), run },
    });
    running.push(instance);
    const response = await fetch(`${instance.origin}/api/ai/analyze`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'unknown', scanId: 'unknown', runnerId: 'unknown' }),
    });
    expect(response.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('returns cited AI drafts directly to the review without saving a file', async () => {
    const { root, project: folder } = await fixture();
    const run = vi.fn(async () => {
      const project = instance.hub.view().project!;
      const source = project.scan.sources.find((item) => item.path === 'README.md')!;
      return JSON.stringify({
        notes: [
          {
            text: 'Notes use Markdown.',
            sourceId: source.id,
            quote: 'This project keeps useful notes in ordinary Markdown files.',
          },
        ],
      });
    });
    const instance = await startLocalServer(path.join(root, 'api-data'), {
      gateway: { inspect: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), run },
    });
    running.push(instance);
    await instance.hub.change(() => instance.hub.add(folder));
    const project = instance.hub.view().project!;
    const response = await fetch(`${instance.origin}/api/ai/analyze`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        scanId: project.scan.id,
        runnerId: 'fixture-runner',
        approved: true,
        promptHash: hash(instance.hub.prompt(project.id, project.scan.id)),
      }),
    });
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0]).toMatchObject({
      runnerId: 'fixture-runner',
      projectId: project.id,
      scanId: project.scan.id,
      approved: true,
      classification: 'C3',
      purpose: 'project_notes',
    });
    expect(instance.hub.view().project!.notes.some((note) => note.kind === 'ai')).toBe(true);
    expect(instance.hub.view().project!.savedPath).toBeNull();
  });

  it('rejects stale source files before sending anything to an AI', async () => {
    const { root, project: folder } = await fixture();
    const run = vi.fn();
    const instance = await startLocalServer(path.join(root, 'api-data'), {
      gateway: { inspect: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), run },
    });
    running.push(instance);
    await instance.hub.change(() => instance.hub.add(folder));
    const project = instance.hub.view().project!;
    await writeFile(
      path.join(folder, 'README.md'),
      'This project has changed and needs a new scan before analysis.',
    );
    const response = await fetch(`${instance.origin}/api/ai/analyze`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        scanId: project.scan.id,
        runnerId: 'fixture-runner',
        approved: true,
        promptHash: hash(instance.hub.prompt(project.id, project.scan.id)),
      }),
    });
    expect(response.status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });

  it('requires the exact reviewed prompt before sending any excerpts', async () => {
    const { root, project: folder } = await fixture();
    const run = vi.fn();
    const instance = await startLocalServer(path.join(root, 'api-data'), {
      gateway: { inspect: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), run },
    });
    running.push(instance);
    await instance.hub.change(() => instance.hub.add(folder));
    const project = instance.hub.view().project!;
    const headers = {
      Authorization: `Bearer ${instance.token}`,
      'Content-Type': 'application/json',
    };
    const body = { projectId: project.id, scanId: project.scan.id, approved: true };
    const preview = await fetch(`${instance.origin}/api/prompt`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const payload = await preview.json();
    expect(payload.promptHash).toBe(hash(payload.text));
    expect(run).not.toHaveBeenCalled();
    const send = await fetch(`${instance.origin}/api/ai/analyze`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, runnerId: 'fixture-runner', promptHash: 'different' }),
    });
    expect(send.status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not import when canceled during the post-analysis source check', async () => {
    const { root, project: folder } = await fixture();
    let releaseScan!: () => void;
    const heldScan = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let scanCalls = 0;
    let scanReleased = false;
    let runnerSignal: AbortSignal | undefined;
    const instance = await startLocalServer(path.join(root, 'api-data'), {
      gateway: {
        inspect: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        async run(_request, signal) {
          runnerSignal = signal;
          const source = instance.hub
            .view()
            .project!.scan.sources.find((item) => item.path === 'README.md')!;
          return JSON.stringify({
            notes: [
              {
                text: 'The project uses Markdown.',
                sourceId: source.id,
                quote: 'This project keeps useful notes in ordinary Markdown files.',
              },
            ],
          });
        },
      },
      async verifyScan() {
        scanCalls++;
        if (scanCalls === 2) {
          await heldScan;
          scanReleased = true;
        }
        return structuredClone(instance.hub.view().project!.scan);
      },
    });
    running.push(instance);
    await instance.hub.change(() => instance.hub.add(folder));
    const project = instance.hub.view().project!;
    const previousNotes = structuredClone(project.notes);
    const controller = new AbortController();
    const request = fetch(`${instance.origin}/api/ai/analyze`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${instance.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: project.id,
        scanId: project.scan.id,
        runnerId: 'fixture-runner',
        approved: true,
        promptHash: hash(instance.hub.prompt(project.id, project.scan.id)),
      }),
      signal: controller.signal,
    }).catch(() => null);
    await expect.poll(() => scanCalls).toBe(2);
    controller.abort();
    await request;
    await expect.poll(() => runnerSignal?.aborted).toBe(true);
    releaseScan();
    await expect.poll(() => scanReleased).toBe(true);
    const state = await fetch(`${instance.origin}/api/state`, {
      headers: { Authorization: `Bearer ${instance.token}` },
    });
    expect((await state.json()).project.notes).toEqual(previousNotes);
  });
});
