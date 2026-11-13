// Uses an existing Playwright install. No browser or package downloads occur here.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startLocalServer } from '../dist/server.js';

const modulePath = process.env.MEMORY_HUB_PLAYWRIGHT;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const { expect } = await import(
  modulePath
    ? pathToFileURL(path.join(path.dirname(modulePath), 'test.mjs')).href
    : 'playwright/test'
);
const root = await mkdtemp(path.join(tmpdir(), 'memory-hub-browser-'));
const project = path.join(root, 'Garden notes');
await mkdir(project);
await writeFile(
  path.join(project, 'README.md'),
  '# Garden notes\n\nThis project stores planting dates and harvest notes in Markdown.\n\n<img src=x onerror="window.untrustedRan=true">\n',
);
await writeFile(
  path.join(project, 'package.json'),
  JSON.stringify(
    { name: 'garden-notes', description: 'A private planting journal.', version: '1.0.0' },
    null,
    2,
  ),
);
let connection = null;
let analysisCount = 0;
let inspectCount = 0;
let pauseAnalysis = false;
let pendingAnalysis = false;
const detected = {
  binaryHash: '0'.repeat(64),
  binaryPath: process.execPath,
  version: 'fixture',
  suggestedModel: 'fixture-model',
  models: [{ id: 'fixture-model', label: 'Fixture AI' }],
  loggedIn: true,
};
const gateway = {
  async inspect() {
    inspectCount++;
    return { available: true, problem: null, detected, connection };
  },
  async connect(input) {
    assert.equal(input.model, 'fixture-model');
    assert.equal(input.approved, true);
    connection = {
      id: 'fixture-runner',
      kind: 'codex_cli',
      binaryPath: detected.binaryPath,
      binaryHash: detected.binaryHash,
      version: 'fixture',
      model: input.model,
      connectedAt: new Date().toISOString(),
    };
    return connection;
  },
  async disconnect() {
    connection = null;
  },
  async run(request, signal) {
    analysisCount++;
    assert.equal(request.approved, true);
    assert.equal(request.runnerId, connection.id);
    if (pauseAnalysis) {
      pendingAnalysis = true;
      try {
        await new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('Canceled'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('Canceled')), { once: true });
        });
      } finally {
        pendingAnalysis = false;
      }
    }
    const sources = JSON.parse(request.prompt.split('Evidence follows as JSON:\n\n')[1]);
    const source = sources.find((item) => item.path === 'README.md');
    const quote = source.text.split('\n').find((line) => line.startsWith('This project'));
    return JSON.stringify({
      notes: [
        { text: 'The project stores garden notes in Markdown.', sourceId: source.sourceId, quote },
      ],
    });
  },
};
const app = await startLocalServer(path.join(root, 'data'), {
  picker: async () => project,
  gateway,
});
let browser;
const output = fileURLToPath(new URL('../../../.local-data/checks/', import.meta.url));

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  let releaseState;
  const stateGate = new Promise((resolve) => {
    releaseState = resolve;
  });
  await page.route('**/api/state', async (route) => {
    await stateGate;
    await route.continue();
  });
  await page.goto(`${app.origin}/#${app.token}`);
  await expect(page.getByRole('button', { name: 'Add a project' })).toBeDisabled();
  releaseState();
  await expect(page.getByRole('heading', { name: 'Start with one project.' })).toBeVisible();
  await page.unroute('**/api/state');
  const failedStart = await context.newPage();
  await failedStart.route('**/api/state', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Fixture startup failure. Try again.' }),
    }),
  );
  await failedStart.goto(`${app.origin}/#${app.token}`);
  await expect(failedStart.getByRole('button', { name: 'Add a project' })).toBeDisabled();
  await expect(failedStart.getByRole('button', { name: 'Try again' })).toBeVisible();
  await failedStart.unroute('**/api/state');
  await failedStart.getByRole('button', { name: 'Try again' }).click();
  await expect(failedStart.getByRole('heading', { name: 'Start with one project.' })).toBeVisible();
  await failedStart.close();
  await page.getByRole('button', { name: 'Choose a project folder', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Garden notes', exact: true })).toBeVisible();
  assert.equal(inspectCount, 0, 'Opening a project must not check Codex automatically');
  await expect(page.locator('[data-note]')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Save selected notes' })).toBeEnabled();
  await page.locator('[data-note]').last().focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('status')).toHaveText('Selection saved. No note files changed.');
  await expect(page.locator('[data-note]').last()).toBeFocused();
  await expect(page.locator('#selection-count')).toHaveText('3');
  await page.getByRole('button', { name: 'Save selected notes' }).click();
  await expect(page.getByRole('status')).toContainText('Note saved.');
  const savedPath = app.hub.view().project.savedPath;
  const firstSaved = await readFile(savedPath, 'utf8');
  assert.equal(firstSaved, app.hub.view().markdown);
  await page.getByRole('button', { name: 'Save selected notes' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Already saved. No duplicate file was created.',
  );
  await page.getByText('Use another AI manually', { exact: true }).click();
  await page.getByLabel('I will choose where to share these project excerpts.').check();
  await page.getByRole('button', { name: 'Review the prompt' }).click();
  await expect(page.locator('#prompt-area')).toBeVisible();
  await page.getByRole('button', { name: 'Copy prompt', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Prompt copied.');
  assert.match(
    await page.evaluate(() => navigator.clipboard.readText()),
    /Evidence follows as JSON/,
  );
  await page.getByLabel('AI reply').fill('not valid json');
  await page.getByRole('button', { name: 'Review AI suggestions' }).click();
  await expect(page.getByRole('alert')).toContainText('not valid JSON');
  await expect(page.getByLabel('AI reply')).toHaveValue('not valid json');
  const source = app.hub.view().project.scan.sources.find((item) => item.path === 'README.md');
  const reply = JSON.stringify({
    notes: [
      {
        text: 'Planting dates are stored in Markdown.',
        sourceId: source.id,
        quote: 'This project stores planting dates and harvest notes in Markdown.',
      },
    ],
  });
  await page.getByLabel('AI reply').fill(reply);
  await page.getByRole('button', { name: 'Review AI suggestions' }).click();
  await expect(page.getByRole('status')).toContainText('AI suggestions added.');
  await expect(page.locator('.tag', { hasText: 'AI draft' })).toBeVisible();
  await expect(page.locator('#selection-count')).toHaveText('4');
  await page.reload();
  await expect(page.locator('.tag', { hasText: 'AI draft' })).toBeVisible();
  await expect(page.locator('[data-note]')).toHaveCount(5);
  await writeFile(
    path.join(project, 'README.md'),
    '# Garden notes\n\nThis project now stores watering dates and harvest notes in Markdown.\n',
  );
  await page.getByRole('button', { name: 'Save selected notes' }).click();
  await expect(page.getByRole('alert')).toContainText('Project files changed.');
  assert.equal(await readFile(savedPath, 'utf8'), firstSaved);
  await page.getByRole('button', { name: 'Scan again', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Scan complete.');
  await expect(page.locator('.tag', { hasText: 'AI draft' })).toHaveCount(0);
  await expect(page.locator('#projects small')).toHaveText('Ready to review');
  assert.equal(await page.evaluate(() => window.untrustedRan), undefined);

  await mkdir(path.join(project, 'docs'));
  await writeFile(
    path.join(project, 'docs', 'README.md'),
    'Planting notes include dates for each garden bed.\nHarvest notes include the plant and the collection date.\n',
  );
  await page.getByRole('button', { name: 'Scan again', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Scan complete.');
  await expect(page.locator('[data-note]:visible')).toHaveCount(5);
  const hiddenNote = app.hub.view().project.notes[5].id;
  await expect(page.locator('#selection-count')).toHaveText('0');
  await page.getByRole('button', { name: 'Show the next 5 notes' }).click();
  await page.locator(`#note-${hiddenNote}`).check();
  await expect(page.getByRole('status')).toContainText('Selection saved.');
  await page.locator('[data-note]').first().check();
  await expect(page.getByRole('status')).toContainText('Selection saved.');
  await page.reload();
  await expect(page.locator('[data-note]:visible')).toHaveCount(5);
  await page.locator('[data-note]').first().uncheck();
  await expect(page.getByRole('status')).toContainText('Selection saved.');
  assert.ok(app.hub.view().project.selected.includes(hiddenNote));
  await page.getByText('Use another AI manually', { exact: true }).click();
  await page.getByLabel('I will choose where to share these project excerpts.').check();
  await page.getByRole('button', { name: 'Review the prompt' }).click();
  await page.getByLabel('AI reply').fill('Keep this unfinished reply.');
  await page.getByRole('button', { name: 'Show the next 5 notes' }).click();
  await expect(page.locator('[data-note]:visible')).toHaveCount(6);
  await expect(page.locator(`#note-${hiddenNote}`)).toBeChecked();
  await expect(page.locator(`#note-${hiddenNote}`)).toBeFocused();
  await expect(page.getByLabel('AI reply')).toHaveValue('Keep this unfinished reply.');
  await expect(
    page.getByLabel('I will choose where to share these project excerpts.'),
  ).toBeChecked();
  await expect(page.locator('#prompt-area')).toBeVisible();
  await page.getByText('Use another AI manually', { exact: true }).click();
  await page.getByRole('button', { name: 'Check for Codex', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Use this AI', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use this AI', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('AI connected.');
  await expect(page.getByLabel('AI reply')).toHaveValue('Keep this unfinished reply.');
  await page.reload();
  await page.getByRole('button', { name: 'Check for Codex', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Draft notes with Codex', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Draft notes with Codex', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Evidence follows as JSON');
  assert.equal(analysisCount, 0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  assert.equal(analysisCount, 0);
  await page.getByRole('button', { name: 'Draft notes with Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Send to Codex', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Your AI drafted the notes.');
  await expect(page.locator('.tag', { hasText: 'AI draft' }).first()).toBeVisible();
  assert.equal(analysisCount, 1);
  assert.equal(app.hub.view().project.savedPath, savedPath);

  const notesBeforeCancel = JSON.stringify(app.hub.view().project.notes);
  pauseAnalysis = true;
  await page.getByRole('button', { name: 'Draft notes with Codex', exact: true }).click();
  await page.getByRole('button', { name: 'Send to Codex', exact: true }).click();
  await expect.poll(() => pendingAnalysis).toBe(true);
  await page.getByRole('button', { name: 'Cancel analysis', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Analysis canceled. No note files were saved.');
  await expect.poll(() => pendingAnalysis).toBe(false);
  assert.equal(JSON.stringify(app.hub.view().project.notes), notesBeforeCancel);
  pauseAnalysis = false;

  const originalId = app.hub.view().project.id;
  const batchFolders = ['Changed project', 'Missing project', 'Unchanged project'].map((name) =>
    path.join(root, name),
  );
  for (const folder of batchFolders) {
    await mkdir(folder);
    await writeFile(
      path.join(folder, 'README.md'),
      'This project keeps its documentation in Markdown files.',
    );
    await app.hub.change(() => app.hub.add(folder));
  }
  await app.hub.change(async () => app.hub.select(originalId));
  await writeFile(
    path.join(batchFolders[0], 'README.md'),
    'This project now has a different purpose that needs review.',
  );
  await rename(batchFolders[1], `${batchFolders[1]}-moved`);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Garden notes', exact: true })).toBeVisible();
  let releaseScan;
  const scanGate = new Promise((resolve) => {
    releaseScan = resolve;
  });
  let scanCalls = 0;
  await page.route('**/api/scan', async (route) => {
    scanCalls++;
    if (scanCalls === 1) await scanGate;
    await route.continue();
  });
  const runsBeforeBatch = analysisCount;
  await page.getByRole('button', { name: 'Update all projects', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Update all projects', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('#status')).toContainText('Checked 0 of 4.');
  releaseScan();
  await expect(page.locator('#status')).toContainText(
    'Checked 4 projects. 1 changed. 2 unchanged. 1 could not be checked.',
  );
  await page.unroute('**/api/scan');
  assert.equal(scanCalls, 4);
  assert.equal(analysisCount, runsBeforeBatch);
  assert.equal(app.hub.view().project.id, originalId);
  assert.equal(JSON.stringify(app.hub.view().project.notes), notesBeforeCancel);
  assert.equal(await readFile(savedPath, 'utf8'), firstSaved);
  await expect(page.getByRole('heading', { name: 'Garden notes', exact: true })).toBeVisible();
  await expect(page.locator('#batch-result')).toContainText('Missing project');

  const otherMemory = path.join(root, 'Other memory');
  await mkdir(otherMemory);
  const secondTab = await context.newPage();
  await secondTab.goto(`${app.origin}/#${app.token}`);
  await secondTab.getByText('Change memory folder', { exact: true }).click();
  await secondTab.getByLabel('Or enter a folder path').fill(otherMemory);
  await secondTab.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await expect(secondTab.getByRole('status')).toContainText('Memory folder changed.');
  assert.notEqual(await page.locator('#destination-path').inputValue(), otherMemory);
  await page.locator('[data-note]').first().click();
  await expect(page.locator('#destination-path')).toHaveValue(otherMemory);
  await expect(page.getByRole('heading', { name: 'Garden notes', exact: true })).toBeVisible();
  await secondTab.close();

  await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      `Overflow at ${width}px`,
    );
  }
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  assert.deepEqual(failures, []);
  console.log(
    'PASS: choose, review, save, repeat save, AI round-trip, invalid reply recovery, reload, stale evidence, safe rendering, desktop, and 320px mobile.',
  );
  console.log(`Screenshots: ${output}`);
} finally {
  await browser?.close();
  app.server.closeAllConnections();
  await new Promise((resolve) => app.server.close(resolve));
}
