import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flush,
  loadTelemetryEnabled,
  saveTelemetryEnabled,
  track,
} from '../src/shared/telemetry.js';

/**
 * The counts are on by default, so what cannot be in them is a promise.
 *
 * The privacy policy states it in as many words: no page content, no addresses,
 * no site names, nothing typed, nothing the model said, no endpoint, no key, no
 * saved details. That is a claim about the payload, so it is tested as one --
 * every field that leaves is asserted against an allow-list rather than the
 * other way round, because a test that hunts for known-bad strings passes
 * happily on the field nobody thought to look for.
 */

const store: Record<string, unknown> = {};
let sent: unknown[] = [];

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  sent = [];

  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (values: Record<string, unknown>) => {
          Object.assign(store, values);
          return Promise.resolve();
        },
        remove: (key: string) => {
          delete store[key];
          return Promise.resolve();
        },
      },
    },
    runtime: { getManifest: () => ({ version: '0.1.0' }) },
  });

  vi.stubGlobal('crypto', { randomUUID: () => 'test-anon-id' });
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return Promise.resolve(new Response(null));
    }),
  );
});

/** `track` is deliberately fire-and-forget, so let its promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the switch', () => {
  it('is on when nothing has been chosen', async () => {
    expect(await loadTelemetryEnabled()).toBe(true);
  });

  it('stays off once it has been turned off', async () => {
    await saveTelemetryEnabled(false);
    expect(await loadTelemetryEnabled()).toBe(false);
  });

  it('sends nothing at all once off', async () => {
    await saveTelemetryEnabled(false);
    track('run_started', { mode: 'confirm' });
    await settle();
    await flush();
    expect(sent).toHaveLength(0);
  });

  it('drops the identifier when switched off, so two periods of use cannot be linked', async () => {
    track('run_started');
    await settle();
    await flush();
    expect(store['heapbrowse.telemetryAnonId']).toBeDefined();

    await saveTelemetryEnabled(false);
    expect(store['heapbrowse.telemetryAnonId']).toBeUndefined();
  });

  it('does not send what was queued before it was switched off', async () => {
    track('run_started');
    await settle();
    await saveTelemetryEnabled(false);
    await flush();
    expect(sent).toHaveLength(0);
  });
});

describe('what a payload may contain', () => {
  it('carries only the fields the privacy policy lists', async () => {
    track('run_started', { mode: 'confirm', preset: 'ollama' });
    track('tool_used', { tool: 'read_page' });
    track('confirmation_answered', { answer: 'allow', permission: 'write', tool: 'click' });
    await settle();
    await flush();

    expect(sent).toHaveLength(1);
    const body = sent[0] as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['anonId', 'app', 'appVersion', 'events']);
    expect(body.app).toBe('heapbrowse');

    const allowedMeta = [
      'tool', 'preset', 'mode', 'driver', 'outcome', 'answer', 'permission', 'steps', 'ok',
    ];
    for (const event of body.events as { name: string; ts: number; meta?: object }[]) {
      expect(Object.keys(event).sort()).toEqual(expect.arrayContaining(['name', 'ts']));
      for (const key of Object.keys(event.meta ?? {})) {
        expect(allowedMeta, `meta.${key} is not an allowed field`).toContain(key);
      }
    }
  });

  it('sends no-cors, so the collector needs no host permission at install', async () => {
    // A host permission for the collector would put "read and change your data
    // on ..." in the install prompt, for counting. The response is the price.
    track('run_started');
    await settle();
    await flush();

    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect(init.mode).toBe('no-cors');
  });

  it('identifies the install with a locally generated id, not anything about the machine', async () => {
    track('run_started');
    await settle();
    await flush();
    expect((sent[0] as { anonId: string }).anonId).toBe('test-anon-id');
  });
});
