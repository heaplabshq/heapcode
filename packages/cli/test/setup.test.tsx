import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startMockServer, type MockServer } from '../../core/test/mockServer.js';
import { Setup } from '../src/ink/Setup.js';

let home: string;
let server: MockServer | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'heapcode-setup-'));
  vi.stubEnv('HEAPCODE_HOME', home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await server?.close();
  server = undefined;
  await rm(home, { recursive: true, force: true });
});

describe('Setup', () => {
  it('walks through provider -> name -> baseUrl -> model (fetched) -> saved, entirely via arrow keys/Enter', async () => {
    server = await startMockServer({ kind: 'json', status: 200, body: { data: [{ id: 'llama3.1:8b' }, { id: 'qwen2.5-coder' }] } });

    const onComplete = vi.fn();
    const { stdin, lastFrame } = render(<Setup onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 20));

    expect(lastFrame()).toContain('Which provider?');
    // Ollama is pre-selected (initialIndex) — Enter accepts it.
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));

    expect(lastFrame()).toContain('Profile name');
    stdin.write('\r'); // accept default name ("ollama")
    await new Promise((r) => setTimeout(r, 20));

    expect(lastFrame()).toContain('Base URL');
    stdin.write('http://localhost:' + new URL(server.baseUrl).port + '/v1');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('Which model?'), { timeout: 2_000 });
    stdin.write('\r'); // first model in the fetched list

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 2_000 });
    const saved = onComplete.mock.calls[0]![0];
    expect(saved).toMatchObject({ name: 'ollama', preset: 'ollama', model: 'llama3.1:8b' });

    const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
    expect(config.activeProfile).toBe('ollama');
  });

  it('falls back to manual model entry when the endpoint has no /models (e.g. unreachable)', async () => {
    const onComplete = vi.fn();
    const { stdin, lastFrame } = render(<Setup onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 20));

    stdin.write('\r'); // provider: Ollama (default)
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r'); // name: default
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('http://localhost:1/v1'); // nothing listening here
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('Model id'), { timeout: 2_000 });
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('llama3.1:8b');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 2_000 });
    expect(onComplete.mock.calls[0]![0]).toMatchObject({ model: 'llama3.1:8b' });
  });

  it('asks for a masked API key when the chosen preset requires one, and never sends the raw key to a wrong/unreachable endpoint by mistake', async () => {
    // requiresApiKey: true (OpenAI) but redirected to a local mock, not the
    // real api.openai.com — a unit test must never depend on live network access.
    server = await startMockServer({ kind: 'json', status: 200, body: { data: [{ id: 'gpt-4o-mini' }] } });

    const onComplete = vi.fn();
    const { stdin, lastFrame } = render(<Setup onComplete={onComplete} />);
    await new Promise((r) => setTimeout(r, 20));

    // OpenAI is item 0 in providerPresets; Ollama is pre-selected via initialIndex,
    // so move up to OpenAI.
    stdin.write('[A');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r'); // name default
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('http://localhost:' + new URL(server.baseUrl).port + '/v1');
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('API key'), { timeout: 2_000 });
    // The frame can update slightly before the freshly-mounted TextInput's own
    // useInput effect has attached its listener (render commit vs. passive
    // effect timing) — a short settle delay, same reasoning as the very first
    // render needing one before its raw-mode listener is ready.
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).not.toContain('sk-secret'); // not typed yet, sanity check
    stdin.write('sk-secret-123');
    await new Promise((r) => setTimeout(r, 20));
    // Masked input shows *, never the raw key.
    expect(lastFrame()).not.toContain('sk-secret-123');
    stdin.write('\r');

    await vi.waitFor(() => expect(lastFrame()).toContain('Which model?'), { timeout: 2_000 });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer sk-secret-123');
    stdin.write('\r');

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalled(), { timeout: 2_000 });
  });
});
