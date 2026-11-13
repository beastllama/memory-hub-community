// Explicit live check. Uses only a synthetic public README and the supplied model.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startLocalServer } from '../dist/server.js';
import { RunnerGateway } from '@memory-hub/runners';

const modelIndex = process.argv.indexOf('--model');
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : null;
if (!model) throw new Error('Pass --model with the model you approve for this check.');
const root = await mkdtemp(path.join(tmpdir(), 'memory-hub-ai-smoke-'));
const project = path.join(root, 'sample-project');
await mkdir(project);
await writeFile(
  path.join(project, 'README.md'),
  '# Sample garden\n\nThis sample project stores planting dates in Markdown files.\n',
);
const gateway = await RunnerGateway.open(path.join(root, 'data', 'ai'));
const observedGateway = {
  inspect: () => gateway.inspect(),
  connect: (input) => gateway.connect(input),
  disconnect: () => gateway.disconnect(),
  async run(...args) {
    try {
      return await gateway.run(...args);
    } catch (error) {
      if (process.argv.includes('--diagnostics') && error?.diagnostic) {
        console.log(JSON.stringify({ syntheticCheckDiagnostic: error.diagnostic }));
      }
      throw error;
    }
  },
};
const app = await startLocalServer(path.join(root, 'data'), { gateway: observedGateway });
const headers = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
async function request(route, body) {
  const response = await fetch(`${app.origin}/api/${route}`, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? 'The synthetic AI check failed.');
  return value;
}
try {
  const status = await request('ai');
  assert.ok(
    status.available && status.detected?.loggedIn,
    status.problem ?? 'Codex is unavailable.',
  );
  const connected = await request('ai/connect', {
    binaryHash: status.detected.binaryHash,
    model,
    approved: true,
  });
  const added = await request('projects', { path: project });
  const { id, scan } = added.view.project;
  const preview = await request('prompt', { projectId: id, scanId: scan.id, approved: true });
  const result = await request('ai/analyze', {
    projectId: id,
    scanId: scan.id,
    runnerId: connected.connection.id,
    approved: true,
    promptHash: preview.promptHash,
  });
  const drafts = result.view.project.notes.filter((note) => note.kind === 'ai');
  assert.ok(drafts.length > 0, 'No valid AI notes returned.');
  assert.equal(result.view.project.savedPath, null);
  console.log(
    `PASS: ${drafts.length} cited draft(s) returned through the app using the explicitly approved ${model}.`,
  );
  console.log(
    'Input was a synthetic public README. No personal project or vault was read. Nothing was saved to a vault.',
  );
} finally {
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
}
