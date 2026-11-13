import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [zipArgument] = process.argv.slice(2);
assert(process.platform === 'win32' && zipArgument, 'Use Windows and pass the built ZIP.');
const zip = path.resolve(zipArgument);
const expectedChecksum = (await readFile(`${zip}.sha256`, 'utf8')).trim();
const sha = createHash('sha256')
  .update(await readFile(zip))
  .digest('hex');
assert.equal(expectedChecksum, `${sha}  ${path.basename(zip)}`);

const scratch = await mkdtemp(path.join(tmpdir(), 'Memory Hub portable test '));
const extract = path.join(scratch, 'Extracted app');
const profile = path.join(scratch, 'Local app data');
const system32 = path.join(process.env.SystemRoot, 'System32');
await mkdir(extract);
await mkdir(profile);

const env = {
  SystemRoot: process.env.SystemRoot,
  SystemDrive: process.env.SystemDrive,
  TEMP: scratch,
  TMP: scratch,
  USERPROFILE: scratch,
  LOCALAPPDATA: profile,
  PATH: system32,
};
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { env, windowsHide: true, timeout: 30_000, ...options });
  assert.equal(result.error, undefined, `Could not start ${path.basename(file)}.`);
  return result;
}

const whereNode = run(path.join(system32, 'where.exe'), ['node.exe'], { cwd: scratch });
assert.equal(whereNode.status, 1, 'Node must not be discoverable on the test PATH.');
const extraction = run(
  path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:PACK_SMOKE_ZIP, $env:PACK_SMOKE_EXTRACT)',
  ],
  { env: { ...env, PACK_SMOKE_ZIP: zip, PACK_SMOKE_EXTRACT: extract } },
);
assert.equal(extraction.status, 0, 'Could not extract the tested ZIP.');

const bundle = path.join(extract, 'Memory Hub');
const expectedPaths = [
  'README.md',
  'docs/VISUAL-QUICK-START.md',
  'docs/images/01-choose.png',
  'docs/images/02-review.png',
  'docs/images/03-save.png',
  'docs/images/04-ai-preview.png',
  'Start Memory Hub.cmd',
  'THIRD-PARTY-NOTICES.txt',
  'apps/local/dist/hub.js',
  'apps/local/dist/public/app.js',
  'apps/local/dist/public/index.html',
  'apps/local/dist/public/style.css',
  'apps/local/dist/scan.js',
  'apps/local/dist/server.js',
  'apps/local/dist/types.js',
  'apps/local/package.json',
  'examples/Trail Notes/README.md',
  'examples/Trail Notes/package.json',
  'node_modules/@memory-hub/runners/index.js',
  'node_modules/@memory-hub/runners/package.json',
  'node_modules/@memory-hub/scanner/index.js',
  'node_modules/@memory-hub/scanner/package.json',
  'runtime/LICENSE',
  'runtime/node.exe',
];
const candidate = path.basename(zip).endsWith('-CANDIDATE.zip');
if (candidate) {
  expectedPaths.push('CANDIDATE.txt');
  if (await lstat(path.join(bundle, 'LICENSE')).catch(() => null)) expectedPaths.push('LICENSE');
} else expectedPaths.push('LICENSE');
async function relativeFiles(root, current = root) {
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await relativeFiles(root, file)));
    else {
      assert(entry.isFile(), 'Unexpected non-file entry in the ZIP.');
      files.push(path.relative(root, file).split(path.sep).join('/'));
    }
  }
  return files.sort();
}
assert.deepEqual(await relativeFiles(bundle), expectedPaths.sort());
assert.match(
  await readFile(path.join(bundle, 'runtime', 'LICENSE'), 'utf8'),
  /Node\.js contributors/,
);
const runtime = run(path.join(bundle, 'runtime', 'node.exe'), [
  '-p',
  'process.platform + " " + process.arch + " " + process.version',
]);
assert.equal(runtime.status, 0);
assert.equal(runtime.stdout.toString().trim(), 'win32 x64 v22.23.5');

const child = spawn(
  path.join(system32, 'cmd.exe'),
  ['/d', '/s', '/c', '""Start Memory Hub.cmd" --print-url"'],
  {
    cwd: bundle,
    env,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
// The URL includes a local session token. Keep it only in memory, never in output.
function launchAddress() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('The bundled launcher did not start.')),
      20_000,
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-4096);
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{64})/);
      if (match) {
        clearTimeout(timeout);
        stdout = '';
        resolve(new URL(match[0]));
      }
    });
    child.stderr.resume();
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('The bundled launcher could not be started.'));
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`The bundled launcher stopped early (${code}).`));
    });
  });
}

try {
  const url = await launchAddress();
  const app = await fetch(url.origin, { signal: AbortSignal.timeout(5000) });
  assert.equal(app.status, 200);
  assert.match(await app.text(), /Memory Hub/);
  async function api(endpoint, body) {
    const result = await fetch(`${url.origin}/api/${endpoint}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(result.status, 200, `The packaged app failed at ${endpoint}.`);
    return result.json();
  }
  const state = await api('state');
  assert.deepEqual(state.projects, []);
  assert.equal(state.destination, path.join(profile, 'Memory Hub', 'memory'));
  const sample = path.join(bundle, 'examples', 'Trail Notes');
  const sampleBefore = await readFile(path.join(sample, 'README.md'), 'utf8');
  const { view } = await api('projects', { path: sample });
  assert.equal(view.project.name, 'Trail Notes');
  assert(view.project.notes.length > 0);
  const save = {
    projectId: view.project.id,
    scanId: view.project.scan.id,
    reviewHash: view.reviewHash,
  };
  const saved = await api('save', save);
  const output = saved.view.project.savedPath;
  assert(output.startsWith(`${state.destination}${path.sep}`));
  assert.match(await readFile(output, 'utf8'), /Source: README\.md/);
  const again = await api('save', save);
  assert.equal(again.result.unchanged, true);
  assert.equal(await readFile(path.join(sample, 'README.md'), 'utf8'), sampleBefore);
  assert.deepEqual(await relativeFiles(bundle), expectedPaths);
  console.log(
    'PASS: verified archive, bundled runtime, launcher without Node on PATH, sample scan, cited Markdown save, repeat save, and isolation from the ZIP contents.',
  );
} finally {
  if (child.exitCode === null && child.pid) {
    run(path.join(system32, 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f']);
  }
}
