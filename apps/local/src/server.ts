import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RunnerGateway } from '@memory-hub/runners';
import { LocalHub } from './hub.js';
import { checkedPath, containsSecret, hash, scanProject } from './scan.js';
import { HubError } from './types.js';

const runFile = promisify(execFile);
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > 100_000)
    throw new HubError(`The ${key} field is missing or too long.`);
  return value;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json'))
    throw new HubError('Send JSON for this action.', 415);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > 256 * 1024)
      throw new HubError('This request is too large. Use a smaller AI reply.', 413);
    chunks.push(buffer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HubError('The request is not valid JSON. Try the action again.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HubError('The request must be an object.');
  return body as Record<string, unknown>;
}

export async function chooseFolder(): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const script =
        '$folder = (New-Object -ComObject Shell.Application).BrowseForFolder(0, "Choose a folder for Memory Hub", 0, 0); if ($null -ne $folder) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($folder.Self.Path) }';
      const result = await runFile(
        'powershell.exe',
        ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', script],
        { windowsHide: true, timeout: 120_000, maxBuffer: 8192 },
      );
      return result.stdout.trim() || null;
    }
    if (process.platform === 'darwin') {
      const result = await runFile(
        '/usr/bin/osascript',
        ['-e', 'POSIX path of (choose folder with prompt "Choose a folder for Memory Hub")'],
        { timeout: 120_000, maxBuffer: 8192 },
      );
      return result.stdout.trim() || null;
    }
  } catch {
    throw new HubError('The folder picker did not finish. Try again or use a folder path.');
  }
  throw new HubError(
    'Use a folder path on this device. The native picker supports Windows and macOS.',
  );
}

export async function startLocalServer(
  dataDirectory: string,
  options: {
    port?: number;
    picker?: () => Promise<string | null>;
    gateway?: Pick<RunnerGateway, 'inspect' | 'connect' | 'disconnect' | 'run'>;
    verifyScan?: typeof scanProject;
  } = {},
) {
  const hub = await LocalHub.load(dataDirectory);
  const gateway = options.gateway ?? (await RunnerGateway.open(path.join(dataDirectory, 'ai')));
  const verifyScan = options.verifyScan ?? scanProject;
  let analysisBusy = false;
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    try {
      if (
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)
      ) {
        throw new HubError(
          'This request came from another site. Open Memory Hub from its launcher.',
          403,
        );
      }
      const route = new URL(request.url ?? '/', origin).pathname;
      if (request.method === 'GET' && assets.has(route)) {
        const [file, contentType] = assets.get(route)!;
        response.writeHead(200, { 'Content-Type': contentType! });
        response.end(await readFile(path.join(publicDirectory, file!)));
        return;
      }
      const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') ?? '');
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new HubError('This session has ended. Open Memory Hub from its launcher.', 401);
      }
      if (request.method === 'GET' && route === '/api/state') {
        send(response, 200, hub.view());
        return;
      }
      if (request.method === 'GET' && route === '/api/ai') {
        send(response, 200, await gateway.inspect());
        return;
      }
      if (request.method !== 'POST') throw new HubError('This action was not found.', 404);
      const body = await readBody(request);
      if (route === '/api/ai/connect') {
        if (analysisBusy) throw new HubError('Cancel the analysis before changing your AI.', 409);
        if (body.approved !== true)
          throw new HubError('Choose Use this AI to connect your account.');
        await gateway.connect({
          binaryHash: stringField(body, 'binaryHash'),
          model: stringField(body, 'model'),
          approved: true,
        });
        send(response, 200, await gateway.inspect());
        return;
      }
      if (route === '/api/ai/disconnect') {
        if (analysisBusy)
          throw new HubError('Cancel the analysis before disconnecting your AI.', 409);
        await gateway.disconnect();
        send(response, 200, await gateway.inspect());
        return;
      }
      if (route === '/api/ai/analyze') {
        if (analysisBusy)
          throw new HubError('An analysis is already running. Wait for it or cancel it.', 409);
        if (body.approved !== true)
          throw new HubError('Choose Draft notes to allow this analysis.');
        const projectId = stringField(body, 'projectId');
        const scanId = stringField(body, 'scanId');
        const project = hub.project(projectId, scanId);
        if (!project.scan.sources.length)
          throw new HubError('This scan has no source excerpts. Choose another project.');
        const controller = new AbortController();
        const abort = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.once('close', abort);
        analysisBusy = true;
        try {
          if ((await verifyScan(project.root)).id !== scanId)
            throw new HubError('Project files changed. Scan again before drafting notes.', 409);
          const prompt = hub.prompt(projectId, scanId);
          if (containsSecret(prompt))
            throw new HubError('A source may contain a secret. Remove it before analysis.');
          if (body.promptHash !== hash(prompt))
            throw new HubError('Review the current excerpts before sending them to Codex.', 409);
          const raw = await gateway.run(
            {
              runnerId: stringField(body, 'runnerId'),
              projectId,
              scanId,
              prompt,
              approved: true,
              classification: 'C3',
              purpose: 'project_notes',
            },
            controller.signal,
          );
          if (controller.signal.aborted)
            throw new HubError('Analysis canceled. Your existing notes were kept.');
          if ((await verifyScan(project.root)).id !== scanId)
            throw new HubError(
              'Project files changed during analysis. Scan again to use the current files.',
              409,
            );
          await hub.change(async () => {
            if (controller.signal.aborted)
              throw new HubError('Analysis canceled. No note files were saved.');
            hub.import(projectId, scanId, raw);
          });
          send(response, 200, { view: hub.view(), result: null });
        } finally {
          analysisBusy = false;
          response.removeListener('close', abort);
        }
        return;
      }
      if (route === '/api/pick') {
        send(response, 200, { path: await (options.picker ?? chooseFolder)() });
        return;
      }
      if (route === '/api/prompt') {
        if (body.approved !== true)
          throw new HubError('Confirm that you will choose where to share these excerpts.');
        const text = hub.prompt(stringField(body, 'projectId'), stringField(body, 'scanId'));
        send(response, 200, { text, promptHash: hash(text) });
        return;
      }
      const result = await hub.change(async () => {
        switch (route) {
          case '/api/projects':
            await hub.add(stringField(body, 'path'));
            break;
          case '/api/select':
            hub.select(stringField(body, 'projectId'));
            break;
          case '/api/scan':
            return hub.rescan(stringField(body, 'projectId'));
          case '/api/review':
            hub.review(stringField(body, 'projectId'), stringField(body, 'scanId'), body.selected);
            break;
          case '/api/destination':
            await hub.destination(stringField(body, 'path'));
            break;
          case '/api/import':
            hub.import(
              stringField(body, 'projectId'),
              stringField(body, 'scanId'),
              stringField(body, 'text'),
            );
            break;
          case '/api/save':
            return hub.save(
              stringField(body, 'projectId'),
              stringField(body, 'scanId'),
              stringField(body, 'reviewHash'),
            );
          default:
            throw new HubError('This action was not found.', 404);
        }
        return null;
      });
      send(response, 200, { view: hub.view(), result });
    } catch (error) {
      if (response.destroyed) return;
      const message =
        error instanceof HubError
          ? error.message
          : error instanceof Error && error.name === 'RunnerError'
            ? error.message
            : 'This action could not finish. Check folder access and free disk space. Then try again.';
      if (!response.headersSent)
        send(response, error instanceof HubError ? error.status : 500, { error: message });
      else response.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Local address unavailable');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, token, hub };
}

async function launch(): Promise<void> {
  const localDirectory =
    process.platform === 'win32'
      ? path.join(
          process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'),
          'Memory Hub',
        )
      : process.platform === 'darwin'
        ? path.join(homedir(), 'Library', 'Application Support', 'Memory Hub')
        : path.join(homedir(), '.local', 'share', 'memory-hub');
  const dataDirectory = path.resolve(process.env.MEMORY_HUB_DATA_DIR ?? localDirectory);
  await LocalHub.load(dataDirectory);
  const lock = path.join(dataDirectory, 'app.lock');
  try {
    await checkedPath(lock, false);
    if ((await lstat(lock)).size > 32)
      throw new HubError(
        'The app lock needs review. Keep it and restart the app after closing other copies.',
      );
    const pid = Number(await readFile(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new HubError('The app lock is invalid. Keep it for recovery.');
    let running = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') running = false;
    }
    if (running) throw new HubError('Memory Hub is already running. Use its open browser window.');
    await unlink(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lockHandle = await open(lock, 'wx', 0o600);
  await lockHandle.writeFile(String(process.pid));
  await lockHandle.close();
  try {
    const app = await startLocalServer(dataDirectory);
    const url = `${app.origin}/#${app.token}`;
    console.log('Memory Hub is ready. Close this window to stop it.');
    if (process.argv.includes('--print-url')) {
      console.log(`Memory Hub is ready: ${url}`);
      console.log('This address is private to this app session. Do not share it.');
    }
    const close = () => {
      app.server.close();
      void unlink(lock).finally(() => process.exit(0));
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    if (process.argv.includes('--open')) {
      const command =
        process.platform === 'win32'
          ? 'rundll32.exe'
          : process.platform === 'darwin'
            ? 'open'
            : 'xdg-open';
      const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
      execFile(command, args, { windowsHide: true }, (error) => {
        if (error)
          console.log(
            'The browser did not open. Close this window. Start the launcher with --print-url to show a private link.',
          );
      });
    }
  } catch (error) {
    await unlink(lock).catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launch().catch((error: unknown) => {
    console.error(
      error instanceof HubError
        ? error.message
        : 'Memory Hub could not start. Check folder access and try again.',
    );
    process.exitCode = 1;
  });
}
