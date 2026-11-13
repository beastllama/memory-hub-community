import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RunnerGateway,
  RunnerError,
  TESTED_CODEX_HASH,
  type RunnerRequest,
  type RunnerRuntime,
} from './index.js';

const binary = path.resolve('reviewed-codex.exe');
const features = [
  'hooks',
  'plugins',
  'apps',
  'shell_tool',
  'unified_exec',
  'multi_agent',
  'multi_agent_v2',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'image_generation',
  'view_image',
  'code_mode',
  'code_mode_host',
  'memories',
  'skill_search',
  'tool_suggest',
  'skip_host_skill_discovery',
  'skill_mcp_dependency_install',
  'remote_plugin',
  'workspace_dependencies',
  'shell_snapshot',
];
const help =
  '--ignore-user-config --ignore-rules --ephemeral --sandbox --json --output-schema --skip-git-repo-check --model --disable';
const notes = {
  notes: [
    {
      text: 'The project uses TypeScript.',
      sourceId: 'source-1',
      quote: 'The project uses TypeScript.',
    },
  ],
};
const resultEvents = () => [
  { type: 'thread.started', thread_id: 'test-thread' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { type: 'reasoning', text: 'Not imported.' } },
  { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(notes) } },
  { type: 'turn.completed', usage: { output_tokens: 50 } },
];

describe('RunnerGateway', () => {
  let owned: string, gateway: RunnerGateway, runtime: RunnerRuntime;
  let currentHash: string, version: string, loggedIn: boolean;
  let events: unknown[], exitCode: number, hang: boolean;
  let calls: Array<{
    args: string[];
    options: Parameters<RunnerRuntime['spawn']>[2];
    input: string;
    kill: ReturnType<typeof vi.fn>;
  }>;

  beforeEach(async () => {
    owned = await mkdtemp(path.join(tmpdir(), 'memory-hub-runner-test-'));
    await mkdir(path.join(owned, 'auth'));
    await writeFile(
      path.join(owned, 'auth', 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-6.1-sol',
            display_name: 'GPT-6.1-Sol',
            visibility: 'list',
            input_modalities: ['text'],
          },
          {
            slug: 'chosen-model',
            display_name: 'Chosen model',
            visibility: 'list',
            input_modalities: ['text'],
          },
        ],
      }),
    );
    currentHash = TESTED_CODEX_HASH;
    version = '0.153.4';
    loggedIn = true;
    events = resultEvents();
    exitCode = 0;
    hang = false;
    calls = [];
    runtime = {
      platform: 'win32',
      homeDirectory: owned,
      temporaryDirectory: owned,
      environment: {
        CODEX_HOME: path.join(owned, 'auth'),
        SystemRoot: 'C:\\Windows',
        OPENAI_API_KEY: 'product-key-must-not-leak',
        ANTHROPIC_API_KEY: 'other-key',
        GH_TOKEN: 'github-key',
        HTTPS_PROXY: 'http://proxy.invalid',
        OPENAI_BASE_URL: 'https://wrong.invalid',
        ANTHROPIC_MODEL: 'implicit-model',
        PATH: 'C:\\untrusted',
        NODE_OPTIONS: '--require untrusted.js',
      },
      findBinary: async () => binary,
      hashBinary: async () => currentHash,
      spawn(_binary, args, options) {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        let closed = false;
        const close = (code: number) => {
          if (!closed) {
            closed = true;
            child.emit('close', code);
          }
        };
        const kill = vi.fn(() => {
          queueMicrotask(() => close(1));
          return true;
        });
        child.kill = kill;
        const call = { args, options, input: '', kill };
        calls.push(call);
        child.stdin.on('data', (chunk: Buffer) => {
          call.input += chunk.toString();
        });
        child.stdin.on('finish', () =>
          queueMicrotask(() => {
            if (args[0] === '--version') child.stdout.write(`codex-cli ${version}\n`);
            else if (args.includes('--help')) child.stdout.write(help);
            else if (args[0] === 'features')
              child.stdout.write(features.map((name) => `${name} stable false`).join('\n'));
            else if (args[0] === 'login')
              child.stderr.write(loggedIn ? 'Logged in using ChatGPT\n' : 'Not logged in\n');
            else {
              if (hang) return;
              for (const event of events)
                child.stdout.write(
                  typeof event === 'string' ? event : `${JSON.stringify(event)}\n`,
                );
              close(exitCode);
              return;
            }
            close(loggedIn || args[0] !== 'login' ? 0 : 1);
          }),
        );
        return child;
      },
    };
    gateway = await RunnerGateway.open(path.join(owned, 'data'), runtime);
  });
  afterEach(async () => {
    await rm(owned, { recursive: true, force: true });
  });

  async function connect() {
    return gateway.connect({ binaryHash: TESTED_CODEX_HASH, model: 'gpt-6.1-sol', approved: true });
  }
  function request(runnerId: string): RunnerRequest {
    return {
      runnerId,
      projectId: 'project-1',
      scanId: 'scan-1',
      prompt: 'Only supplied source evidence.',
      approved: true,
      classification: 'C3',
      purpose: 'project_notes',
    };
  }

  it('performs zero subprocess launches without connection and explicit live approval', async () => {
    await expect(gateway.run(request('missing'))).rejects.toBeInstanceOf(RunnerError);
    await expect(
      gateway.connect({ binaryHash: TESTED_CODEX_HASH, model: '', approved: true }),
    ).rejects.toThrow('explicit model');
    expect(calls).toHaveLength(0);
    const connection = await connect();
    calls = [];
    for (const bad of [
      { approved: false },
      { runnerId: 'wrong' },
      { projectId: '' },
      { scanId: '' },
      { classification: 'C1' },
      { purpose: 'other' },
      { prompt: 'a'.repeat(100_001) },
    ]) {
      await expect(
        gateway.run({ ...request(connection.id), ...bad } as RunnerRequest),
      ).rejects.toBeInstanceOf(RunnerError);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects unknown binary hashes before any subprocess and unsupported versions before login', async () => {
    currentHash = 'b'.repeat(64);
    expect((await gateway.inspect()).available).toBe(false);
    expect(calls).toHaveLength(0);
    currentHash = TESTED_CODEX_HASH;
    version = '0.999.0';
    expect((await gateway.inspect()).available).toBe(false);
    expect(calls.map((call) => call.args)).toEqual([['--version']]);
  });

  it('returns a safe login problem, never captured auth output', async () => {
    loggedIn = false;
    const result = await gateway.inspect();
    expect(result.available).toBe(false);
    expect(result.detected?.loggedIn).toBe(false);
    expect(result.problem).toContain('Sign in');
    expect(JSON.stringify(result)).not.toContain('product-key');
  });

  it('reads only the root model suggestion and persists no credentials', async () => {
    await writeFile(
      path.join(owned, 'auth', 'config.toml'),
      'model = "chosen-model"\n[profiles.other]\nmodel = "wrong-model"\n',
    );
    expect((await gateway.inspect()).detected?.suggestedModel).toBe('chosen-model');
    const connection = await connect();
    const saved = await readFile(path.join(owned, 'data', 'runner-connection.json'), 'utf8');
    expect(JSON.parse(saved)).toEqual(connection);
    expect(saved).not.toContain('key');
    const reopened = await RunnerGateway.open(path.join(owned, 'data'), runtime);
    expect((await reopened.inspect()).connection).toEqual(connection);
    await writeFile(
      path.join(owned, 'auth', 'config.toml'),
      '[profiles.other]\nmodel = "wrong-model"\n',
    );
    expect((await gateway.inspect()).detected?.suggestedModel).toBeNull();
  });

  it('only offers visible text-compatible models and never suggests an unavailable configured ID', async () => {
    await writeFile(path.join(owned, 'auth', 'config.toml'), 'model = "gpt-6.1-sol"\n');
    await writeFile(
      path.join(owned, 'auth', 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-5.6-terra',
            display_name: 'GPT-5.6-Terra',
            visibility: 'list',
            input_modalities: ['text', 'image'],
          },
          {
            slug: 'hidden-model',
            display_name: 'Hidden',
            visibility: 'hide',
            input_modalities: ['text'],
          },
          {
            slug: 'image-only',
            display_name: 'Image only',
            visibility: 'list',
            input_modalities: ['image'],
          },
        ],
      }),
    );
    const inspection = await gateway.inspect();
    expect(inspection.detected?.models).toEqual([{ id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' }]);
    expect(inspection.detected?.suggestedModel).toBeNull();
    await expect(connect()).rejects.toThrow('available model');
    const connection = await gateway.connect({
      binaryHash: TESTED_CODEX_HASH,
      model: 'gpt-5.6-terra',
      approved: true,
    });
    expect(connection.model).toBe('gpt-5.6-terra');
    expect(JSON.parse(await gateway.run(request(connection.id)))).toEqual(notes);
    const call = calls.find((call) => call.args.includes('--json'))!;
    expect(call.args[call.args.indexOf('--model') + 1]).toBe('gpt-5.6-terra');
  });

  it('returns empty choices and an actionable Check again message when the catalog is absent or oversized', async () => {
    await unlink(path.join(owned, 'auth', 'models_cache.json'));
    let inspection = await gateway.inspect();
    expect(inspection.available).toBe(false);
    expect(inspection.detected?.models).toEqual([]);
    expect(inspection.problem).toContain('Check again');
    await writeFile(path.join(owned, 'auth', 'models_cache.json'), ' '.repeat(1_000_001));
    inspection = await gateway.inspect();
    expect(inspection.detected?.models).toEqual([]);
    expect(inspection.problem).toContain('Check again');
  });

  it('pins arguments, environment, isolated cwd, schema, and project/input bindings', async () => {
    const connection = await connect();
    expect(JSON.parse(await gateway.run(request(connection.id)))).toEqual(notes);
    const call = calls.find((call) => call.args.includes('--json'))!;
    expect(call.options.shell).toBe(false);
    expect(call.options.windowsHide).toBe(true);
    expect(call.options.cwd).not.toBe(path.resolve('.'));
    expect(call.args).toContain('--ignore-user-config');
    expect(call.args).toContain('--ignore-rules');
    expect(call.args).toContain('--ephemeral');
    expect(call.args).toContain('read-only');
    expect(call.args[call.args.indexOf('--model') + 1]).toBe(connection.model);
    expect(call.args.at(-1)).toBe('-');
    expect(call.args).toContain('model_provider="openai"');
    expect(call.args).toContain('approval_policy="never"');
    expect(call.args).toContain('skip_host_skill_discovery');
    for (const name of features.filter((name) => name !== 'skip_host_skill_discovery'))
      expect(call.args).toContain(name);
    expect(Object.keys(call.options.env).sort()).toEqual(
      ['CODEX_HOME', 'HOME', 'PATH', 'SystemRoot'].sort(),
    );
    expect(call.options.env.PATH).toBe('C:\\Windows\\System32');
    expect(call.input).toContain('"projectId":"project-1"');
    expect(call.input).toContain('"scanId":"scan-1"');
    expect(call.input).toMatch(/"inputSha256":"[a-f0-9]{64}"/);
    expect(await readdir(owned)).toEqual(['auth', 'data']);
  });

  it('fails closed after updates without an inference subprocess', async () => {
    const connection = await connect();
    currentHash = 'c'.repeat(64);
    calls = [];
    await expect(gateway.run(request(connection.id))).rejects.toThrow('reviewed');
    expect(calls).toHaveLength(0);
  });

  it('disconnects and revokes the connection without deleting other data', async () => {
    const connection = await connect();
    await writeFile(path.join(owned, 'data', 'unrelated.txt'), 'keep');
    await gateway.disconnect();
    calls = [];
    await expect(gateway.run(request(connection.id))).rejects.toThrow('connected AI');
    expect(calls).toHaveLength(0);
    expect(await readdir(path.join(owned, 'data'))).toEqual(['unrelated.txt']);
  });

  it.each([
    'command_execution',
    'file_change',
    'mcp_tool_call',
    'web_search',
    'request_user_input',
  ])('rejects and stops attempted %s', async (type) => {
    const connection = await connect();
    events = [
      { type: 'item.completed', item: { type: 'error', message: 'Nonfatal warning.' } },
      { type: 'turn.started' },
      { type: 'item.started', item: { type } },
    ];
    await expect(gateway.run(request(connection.id))).rejects.toThrow('tool or interactive action');
    expect(calls.find((call) => call.args.includes('--json'))?.kill).toHaveBeenCalled();
  });

  it.each([
    [{ type: 'turn.started' }, { type: 'turn.failed' }],
    [{ type: 'turn.started' }, { type: 'error', message: 'provider error' }],
    [{ type: 'turn.started' }, { type: 'turn.completed' }],
    ['not-json\n'],
    [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { type: 'agent_message', text: '{"notes":[],"extra":true}' },
      },
      { type: 'turn.completed' },
    ],
  ])('rejects failed, malformed, missing, or schema-invalid results', async (...bad) => {
    const connection = await connect();
    events = bad;
    await expect(gateway.run(request(connection.id))).rejects.toBeInstanceOf(RunnerError);
  });

  it('rejects nonzero exits and oversized streams', async () => {
    const connection = await connect();
    exitCode = 1;
    events = [
      { type: 'item.completed', item: { type: 'error', message: 'Nonfatal warning.' } },
      ...resultEvents(),
    ];
    await expect(gateway.run(request(connection.id))).rejects.toThrow('could not complete');
    exitCode = 0;
    events = ['x'.repeat(1_000_001)];
    await expect(gateway.run(request(connection.id))).rejects.toThrow('size limit');
  });

  it.each([
    ['usage_limit_reached', 'usage limit'],
    ['model_not_found', 'selected model is unavailable'],
    ['authentication_error', 'login is unavailable'],
    ['rate_limit_exceeded', 'rate limited'],
  ])(
    'keeps provider errors actionable without exposing the payload (%s)',
    async (code, message) => {
      const connection = await connect();
      events = [
        { type: 'turn.started' },
        { type: 'error', error: { code, message: 'private diagnostic must not be exposed' } },
      ];
      const failure = await gateway.run(request(connection.id)).catch((cause) => cause as Error);
      expect(failure).toBeInstanceOf(RunnerError);
      expect((failure as Error).message).toContain(message);
      expect((failure as Error).message).not.toContain('private diagnostic');
    },
  );

  it('does not treat a warning-only stream as a completed result', async () => {
    const connection = await connect();
    events = [
      { type: 'thread.started' },
      { type: 'item.completed', item: { type: 'error', message: 'A real startup error.' } },
    ];
    const failure = (await gateway
      .run(request(connection.id))
      .catch((cause) => cause as RunnerError)) as RunnerError;
    expect(failure.message).toContain('did not complete');
    expect(failure.diagnostic?.message).toBe('A real startup error.');
  });

  it('exposes only bounded, redacted structured diagnostics without logging the provider payload', async () => {
    const connection = await connect();
    events = [
      { type: 'turn.started' },
      {
        type: 'error',
        error: {
          message: JSON.stringify({
            error: {
              type: 'invalid_request_error',
              code: 'unsupported_parameter',
              message: `Unsupported option. Authorization: Bearer sk-private-token api_key="another-private-key" "Authorization": "Bearer tiny-secret" ${'A'.repeat(60)} ${'x '.repeat(200)}`,
            },
          }),
        },
      },
    ];
    const failure = (await gateway
      .run(request(connection.id))
      .catch((cause) => cause as RunnerError)) as RunnerError;
    expect(failure.diagnostic?.type).toBe('invalid_request_error');
    expect(failure.diagnostic?.code).toBe('unsupported_parameter');
    expect(failure.diagnostic?.requestedModel).toBe('gpt-6.1-sol');
    expect(failure.diagnostic?.message.length).toBeLessThanOrEqual(300);
    expect(failure.diagnostic?.message).toContain('Unsupported option.');
    expect(failure.diagnostic?.message).not.toMatch(
      /sk-private|another-private-key|tiny-secret|A{32}/,
    );
  });

  it('accepts warning items only as data while keeping the explicit model and provider pinned', async () => {
    const connection = await connect();
    events = [
      { type: 'thread.started' },
      {
        type: 'item.completed',
        item: {
          type: 'error',
          message: 'Model metadata for gpt-6.1-sol not found. Using fallback metadata.',
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'error',
          message: 'Code Mode is unavailable because code-mode host is disabled.',
        },
      },
      ...resultEvents().slice(1),
    ];
    expect(JSON.parse(await gateway.run(request(connection.id)))).toEqual(notes);
    const call = calls.find((call) => call.args.includes('--json'))!;
    expect(call.args[call.args.indexOf('--model') + 1]).toBe('gpt-6.1-sol');
    expect(call.args).toContain('model_provider="openai"');
  });

  it.each([
    { type: 'error', message: 'Model metadata not found; fallback.' },
    { type: 'turn.failed', error: { message: 'Model metadata not found; fallback.' } },
  ])('does not treat top-level errors or failed turns as warnings', async (event) => {
    const connection = await connect();
    events = [event, ...resultEvents()];
    await expect(gateway.run(request(connection.id))).rejects.toBeInstanceOf(RunnerError);
  });

  it('accepts in-turn warning items only when a valid final answer completes afterward', async () => {
    const connection = await connect();
    events = [
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { type: 'error', message: 'Model metadata not found; fallback.' },
      },
      ...resultEvents().slice(2),
    ];
    expect(JSON.parse(await gateway.run(request(connection.id)))).toEqual(notes);
  });

  it('warning followed by a failed turn is always fatal', async () => {
    const connection = await connect();
    events = [
      { type: 'item.completed', item: { type: 'error', message: 'Nonfatal warning.' } },
      { type: 'turn.started' },
      { type: 'turn.failed', error: { code: 'invalid_request_error', message: 'Request failed.' } },
    ];
    await expect(gateway.run(request(connection.id))).rejects.toThrow('Codex reported an error');
  });

  it('retains only the sanitized last warning when no turn completes', async () => {
    const connection = await connect();
    events = [
      { type: 'item.completed', item: { type: 'error', message: 'First warning.' } },
      {
        type: 'item.completed',
        item: { type: 'error', message: 'Last warning. Authorization: Bearer sk-private-token' },
      },
      { type: 'turn.started' },
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(notes) } },
    ];
    const failure = (await gateway
      .run(request(connection.id))
      .catch((cause) => cause as RunnerError)) as RunnerError;
    expect(failure.message).toContain('did not complete');
    expect(failure.diagnostic?.message).toContain('Last warning.');
    expect(failure.diagnostic?.message).not.toMatch(/First warning|sk-private-token/);
  });

  it('handles cancellation, already-cancelled approval, and owned-directory cleanup', async () => {
    const connection = await connect();
    hang = true;
    const controller = new AbortController();
    const pending = gateway.run(request(connection.id), controller.signal);
    await vi.waitFor(() => expect(calls.some((call) => call.args.includes('--json'))).toBe(true));
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(calls.find((call) => call.args.includes('--json'))?.kill).toHaveBeenCalled();
    expect(await readdir(owned)).toEqual(['auth', 'data']);
    calls = [];
    await expect(gateway.run(request(connection.id), controller.signal)).rejects.toThrow(
      'cancelled',
    );
    expect(calls).toHaveLength(0);
  });

  it('bounds hangs and does not silently run after catalog verification is disabled', async () => {
    const connection = await connect();
    hang = true;
    runtime.timeoutMs = 5;
    await expect(gateway.run(request(connection.id))).rejects.toThrow('time limit');
    runtime.toolCatalogVerified = false;
    calls = [];
    await expect(gateway.run(request(connection.id))).rejects.toThrow('not been verified');
    expect(calls).toHaveLength(0);
  });
  it('disconnect during preflight cannot resurrect a connection', async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.hashBinary = async () => {
      await paused;
      return TESTED_CODEX_HASH;
    };
    const pending = connect();
    await gateway.disconnect();
    release();
    await expect(pending).rejects.toThrow('connection changed');
    expect((await gateway.inspect()).connection).toBeNull();
    expect(await readdir(path.join(owned, 'data'))).toEqual([]);
  });

  it('cancellation during a preflight stops before inference', async () => {
    const connection = await connect();
    const original = runtime.spawn;
    runtime.spawn = (file, args, options) => {
      if (args[0] !== '--version') return original(file, args, options);
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {
        queueMicrotask(() => child.emit('close', 1));
        return true;
      };
      return child;
    };
    calls = [];
    const controller = new AbortController();
    const pending = gateway.run(request(connection.id), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(calls.some((call) => call.args.includes('--json'))).toBe(false);
  });
});
