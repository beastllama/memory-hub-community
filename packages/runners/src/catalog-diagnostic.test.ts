import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { it } from 'vitest';
import { RunnerGateway, TESTED_CODEX_HASH, type RunnerRuntime } from './index.js';

// Explicit, development-only localhost fixture. No inference, login files, headers, or input logs.
it.skipIf(!process.env.MEMORY_HUB_CATALOG_BINARY)(
  'reports the synthetic request tool catalog',
  async () => {
    const binary = process.env.MEMORY_HUB_CATALOG_BINARY!;
    const model = process.env.MEMORY_HUB_CATALOG_MODEL ?? 'gpt-5.1-codex';
    const owned = await mkdtemp(path.join(tmpdir(), 'memory-hub-catalog-'));
    const names = new Set<string>();
    let captured = false;
    let requestModelUnchanged = true;
    let warningItems = 0;
    const server = createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        try {
          const message = JSON.parse(body) as {
            model?: string;
            tools?: Array<{ name?: string; type?: string; function?: { name?: string } }>;
          };
          for (const tool of message.tools ?? [])
            names.add(tool.name ?? tool.function?.name ?? tool.type ?? 'unknown');
          if (request.method === 'POST') {
            captured = true;
            requestModelUnchanged &&= message.model === model;
          }
        } catch {
          /* Non-Responses requests are deliberately not logged. */
        }
        const text = JSON.stringify({
          notes: [
            {
              text: 'Synthetic public fact.',
              sourceId: 'fixture-source',
              quote: 'Synthetic public fact.',
            },
          ],
        });
        const item = {
          id: 'fixture-message',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        };
        const event = (value: Record<string, unknown>) =>
          `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(
          event({
            type: 'response.created',
            response: { id: 'fixture-response', status: 'in_progress', output: [] },
          }),
        );
        response.write(
          event({
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...item, status: 'in_progress', content: [] },
          }),
        );
        response.write(
          event({
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: text,
          }),
        );
        response.write(event({ type: 'response.output_item.done', output_index: 0, item }));
        response.end(
          event({
            type: 'response.completed',
            response: {
              id: 'fixture-response',
              status: 'completed',
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          }),
        );
      });
    });
    try {
      await mkdir(path.join(owned, 'auth'));
      await writeFile(
        path.join(owned, 'auth', 'models_cache.json'),
        JSON.stringify({
          models: [
            {
              slug: model,
              display_name: 'Synthetic catalog selection',
              visibility: 'list',
              input_modalities: ['text'],
            },
          ],
        }),
      );
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No local fixture address.');
      const runtime: RunnerRuntime = {
        platform: process.platform,
        environment: {
          ...process.env,
          CODEX_HOME: path.join(owned, 'auth'),
          USERPROFILE: owned,
          HOME: owned,
          APPDATA: owned,
          LOCALAPPDATA: owned,
        },
        homeDirectory: owned,
        temporaryDirectory: owned,
        timeoutMs: 30_000,
        toolCatalogVerified: true,
        findBinary: async () => binary,
        hashBinary: async (file) => {
          const digest = createHash('sha256');
          for await (const chunk of createReadStream(file)) digest.update(chunk);
          return digest.digest('hex');
        },
        spawn(executable, args, options) {
          if (args[0] === 'login') {
            const child = new EventEmitter() as ChildProcessWithoutNullStreams;
            child.stdin = new PassThrough();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            queueMicrotask(() => {
              child.stderr.write('Logged in using ChatGPT\n');
              child.emit('close', 0);
            });
            return child;
          }
          if (args[0] === 'exec' && args.includes('--json')) {
            args = args.map((value) =>
              value === 'model_provider="openai"' ? 'model_provider="memory_hub_fixture"' : value,
            );
            args.splice(
              args.length - 1,
              0,
              '-c',
              'model_providers.memory_hub_fixture.name="Synthetic no-auth fixture"',
              '-c',
              `model_providers.memory_hub_fixture.base_url="http://127.0.0.1:${address.port}/v1"`,
              '-c',
              'model_providers.memory_hub_fixture.wire_api="responses"',
              '-c',
              'model_providers.memory_hub_fixture.requires_openai_auth=false',
              '-c',
              'model_providers.memory_hub_fixture.request_max_retries=0',
              '-c',
              'model_providers.memory_hub_fixture.stream_max_retries=0',
            );
          }
          const child = spawn(executable, args, options);
          if (args[0] === 'exec' && args.includes('--json')) {
            // Observe warning categories without logging payloads. The gateway consumes the
            // real CLI stream, including its completed turn and synthetic final answer.
            const nativeOutput = child.stdout;
            let pending = '';
            nativeOutput.on('data', (chunk: Buffer) => {
              pending += chunk.toString();
              let newline: number;
              while ((newline = pending.indexOf('\n')) !== -1) {
                const line = pending.slice(0, newline);
                pending = pending.slice(newline + 1);
                try {
                  const event = JSON.parse(line);
                  if (event.type === 'item.completed' && event.item?.type === 'error')
                    warningItems++;
                } catch {
                  /* No raw diagnostics are logged. */
                }
              }
            });
          }
          return child;
        },
      };
      const gateway = await RunnerGateway.open(path.join(owned, 'data'), runtime);
      const connection = await gateway.connect({
        binaryHash: TESTED_CODEX_HASH,
        model,
        approved: true,
      });
      const result = await gateway.run({
        runnerId: connection.id,
        projectId: 'synthetic-project',
        scanId: 'synthetic-scan',
        prompt: 'Synthetic fixture: return one example note, without using tools.',
        approved: true,
        classification: 'C3',
        purpose: 'project_notes',
      });
      if (JSON.parse(result).notes[0]?.text !== 'Synthetic public fact.')
        throw new Error('The local CLI did not return the validated synthetic result.');
      if (!captured) throw new Error('The synthetic provider received no request.');
      const tools = [...names].sort();
      process.stdout.write(
        `${JSON.stringify({ requestModelUnchanged, tools, zeroFilesystemExecutionMcpTools: tools.every((name) => name === 'request_user_input'), nonfatalWarningObserved: warningItems > 0, completedValidResult: true })}\n`,
      );
      if (!requestModelUnchanged)
        throw new Error('The CLI substituted the explicitly selected model.');
      if (!warningItems)
        throw new Error('The fixture did not exercise a nonfatal thread error item.');
      if (tools.some((name) => name !== 'request_user_input'))
        throw new Error('The CLI exposes an unapproved tool catalog.');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(owned, { recursive: true, force: true });
    }
  },
  60_000,
);
