// Capture the real UI with a synthetic project, a fixture picker, and no live AI.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startLocalServer } from '../apps/local/dist/server.js';

const modulePath = process.env.MEMORY_HUB_PLAYWRIGHT;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const temp = await mkdtemp(path.join(tmpdir(), 'memory-hub-guide-'));
const project = path.join(temp, 'Trail Notes');
const memory = path.join(temp, 'Example vault');
const output = new URL('../docs/images/', import.meta.url);
let app;
let browser;

try {
  await cp(new URL('../examples/Trail%20Notes/', import.meta.url), project, { recursive: true });
  await mkdir(memory);
  const connection = {
    id: 'sample-runner',
    kind: 'codex_cli',
    binaryPath: 'C:\\Demo\\codex.exe',
    binaryHash: '0'.repeat(64),
    version: '0.153.4',
    model: 'demo-only',
    connectedAt: '2000-01-01T00:00:00.000Z',
  };
  app = await startLocalServer(path.join(temp, 'data'), {
    picker: async () => project,
    gateway: {
      async inspect() {
        return { available: true, problem: null, detected: null, connection };
      },
      async run() {
        throw new Error('The guide must never send data to AI.');
      },
    },
  });
  const local = app;
  const requests = [];
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 900 },
    bypassCSP: true, // Allow the capture-only highlight stylesheet.
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== local.origin) return route.abort();
    requests.push(url.pathname);
    return route.continue();
  });
  await page.goto(`${app.origin}/#${app.token}`);
  await mkdir(output, { recursive: true });

  async function capture(filename, region, target) {
    await page.addStyleTag({
      content: `
        [data-guide-target] { outline: 3px solid #1464c4; outline-offset: 2px; }
        summary[data-guide-target] { outline-offset: -2px; border-radius: 4px; }
        #ai-share-dialog { margin: auto; }
      `,
    });
    await page.evaluate(
      ({ privateRoot, demoRoot, target }) => {
        const substitute = (text) => text.split(privateRoot).join(demoRoot);
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());)
          node.nodeValue = substitute(node.nodeValue ?? '');
        for (const field of document.querySelectorAll('input')) {
          if (field.value.includes(privateRoot)) {
            field.value = substitute(field.value);
            field.setAttribute('value', field.value);
          }
        }
        document.querySelector('[data-guide-target]')?.removeAttribute('data-guide-target');
        document.querySelector(target)?.setAttribute('data-guide-target', '');
      },
      { privateRoot: temp, demoRoot: 'C:\\Demo', target },
    );
    assert.ok(!(await page.locator('body').innerText()).includes(temp));
    assert.ok(!(await page.locator('body').innerText()).includes(local.token));
    const area = typeof region === 'string' ? page.locator(region) : region;
    await area.screenshot({
      path: fileURLToPath(new URL(filename, output)),
      animations: 'disabled',
    });
  }

  await page.getByRole('heading', { name: 'Start with one project.' }).waitFor();
  await capture('01-choose.png', '.intro', '#choose-project');
  await page.getByRole('button', { name: 'Choose a project folder' }).click();
  await page.getByRole('heading', { name: 'Trail Notes', exact: true }).waitFor();
  const readme = page.locator('.note-row details summary').filter({ hasText: 'README.md' });
  await readme.first().click();
  await capture(
    '02-review.png',
    page.locator('.note-row').filter({ has: page.locator('details[open]') }),
    '.note-row details[open] summary',
  );

  await page.getByText('Change memory folder', { exact: true }).click();
  await page.getByLabel('Or enter a folder path').fill(memory);
  await page.getByRole('button', { name: 'Use this folder', exact: true }).click();
  await page.getByText('Memory folder changed. No notes were written.').waitFor();
  await page.getByRole('button', { name: 'Save selected notes' }).click();
  await page.getByText('Last saved note', { exact: true }).waitFor();
  const savedPath = app.hub.view().project.savedPath;
  assert.ok(savedPath.startsWith(memory));
  assert.match(await readFile(savedPath, 'utf8'), /Source: README\.md/);
  await capture('03-save.png', '.save-panel', '#save');

  await page.getByRole('button', { name: 'Check for Codex' }).click();
  await page.getByRole('button', { name: 'Draft notes with Codex' }).click();
  await page.getByRole('dialog').waitFor();
  await page.locator('#ai-share-preview').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await capture('04-ai-preview.png', '#ai-share-dialog', '#cancel-ai-share');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.ok(!requests.includes('/api/ai/analyze'));
  console.log('Captured four guide screens. No live AI or external network requests.');
} finally {
  await browser?.close();
  if (app) {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  }
  assert.equal(path.dirname(temp), path.resolve(tmpdir()));
  assert.ok(path.basename(temp).startsWith('memory-hub-guide-'));
  await rm(temp, { recursive: true, force: true });
}
