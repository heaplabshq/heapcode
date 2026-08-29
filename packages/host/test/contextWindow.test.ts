import { describe, expect, it, vi } from 'vitest';
import type { ProviderProfileConfig } from '@heapcode/core';
import { createContextWindowResolver } from '../src/provider/resolve.js';

/**
 * How big the window is, and who says so.
 *
 * Two of the three hosts sized their window from the preset alone, and a
 * preset is a guess about a family of endpoints. Guess too small and the
 * conversation compacts earlier than it needs to, which merely wastes context.
 * Guess too large — 128k against a hosted endpoint serving far less — and the
 * meter never looks full, compaction never fires, and the endpoint silently
 * drops the oldest part of the prompt instead. The agent forgets what it read
 * and reads it again: from outside, a run that will not stop.
 */

const cloud: ProviderProfileConfig = {
  name: 'ollama cloud',
  preset: 'ollama-cloud',
  baseUrl: 'https://ollama.com/v1',
  model: 'glm',
};

/** Waits for the background lookup `known()` starts. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the context window a host runs with', () => {
  it('prefers what the endpoint reports over the preset', async () => {
    const resolver = createContextWindowResolver(async () => [{ id: 'glm', contextLength: 32_768 }]);
    expect(await resolver.resolve(cloud, 'glm')).toEqual({ window: 32_768, source: 'model' });
  });

  it('falls back to the preset when the endpoint reports nothing', async () => {
    const resolver = createContextWindowResolver(async () => [{ id: 'glm' }]);
    // ollama-cloud's preset default. Correct to use, worth labelling as a
    // guess, and never worth preferring over an answer.
    expect(await resolver.resolve(cloud, 'glm')).toEqual({ window: 128_000, source: 'preset' });
  });

  it('honours an explicit setting without asking anyone', async () => {
    const listModels = vi.fn(async () => [{ id: 'glm', contextLength: 32_768 }]);
    const resolver = createContextWindowResolver(listModels);
    expect(await resolver.resolve({ ...cloud, contextWindow: 8_000 }, 'glm')).toEqual({
      window: 8_000,
      source: 'profile',
    });
    expect(listModels).not.toHaveBeenCalled();
  });

  it('never waits on the run path, and has the answer by the next turn', async () => {
    // The rule this pins: sizing a window must not delay a turn, still less
    // hang one behind an endpoint that has stopped answering. The first read
    // gets the preset and starts a lookup; later reads get the real number.
    const resolver = createContextWindowResolver(async () => [{ id: 'glm', contextLength: 32_768 }]);

    expect(resolver.known(cloud, 'glm')).toEqual({ window: 128_000, source: 'preset' });
    await settle();
    expect(resolver.known(cloud, 'glm')).toEqual({ window: 32_768, source: 'model' });
  });

  it('asks once per endpoint and model, however often it is read', async () => {
    // This sits on the path of every turn.
    const listModels = vi.fn(async () => [{ id: 'glm', contextLength: 32_768 }]);
    const resolver = createContextWindowResolver(listModels);

    await Promise.all([
      resolver.resolve(cloud, 'glm'),
      resolver.resolve(cloud, 'glm'),
      resolver.resolve(cloud, 'glm'),
    ]);
    resolver.known(cloud, 'glm');

    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('re-asks for a different model on the same endpoint', async () => {
    const listModels = vi.fn(async (_p: string, model?: string) => [
      { id: model!, contextLength: model === 'glm' ? 32_768 : 4_096 },
    ]);
    const resolver = createContextWindowResolver(listModels);

    expect((await resolver.resolve(cloud, 'glm')).window).toBe(32_768);
    expect((await resolver.resolve(cloud, 'tiny')).window).toBe(4_096);
  });

  it('degrades to the preset when the lookup fails, and does not retry forever', async () => {
    const listModels = vi.fn(async () => {
      throw new Error('endpoint is down');
    });
    const resolver = createContextWindowResolver(listModels);

    expect(await resolver.resolve(cloud, 'glm')).toEqual({ window: 128_000, source: 'preset' });
    await resolver.resolve(cloud, 'glm');
    // A dead endpoint must not be probed once per turn for the whole session.
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('says so when nothing anywhere reported a size', async () => {
    // `custom` carries no preset window, so this is a conservative fallback —
    // the one case where "is this number right" should be answered "probably
    // not".
    const resolver = createContextWindowResolver(async () => []);
    const custom: ProviderProfileConfig = {
      name: 'custom',
      preset: 'custom',
      baseUrl: 'http://localhost:8000/v1',
      model: 'm',
    };
    expect(await resolver.resolve(custom, 'm')).toEqual({ window: 32_768, source: 'default' });
  });
});
