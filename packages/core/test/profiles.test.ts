import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
  type ProviderProfileConfig,
} from '../src/index.js';

const profile = (over: Partial<ProviderProfileConfig>): ProviderProfileConfig => ({
  name: 'p',
  preset: 'custom',
  baseUrl: 'http://localhost:8000/v1',
  model: 'm',
  ...over,
});

describe('resolveContextWindow', () => {
  it('explicit profile setting wins over everything', () => {
    expect(resolveContextWindow(profile({ preset: 'openai', contextWindow: 200_000 }))).toBe(
      200_000,
    );
  });

  it('falls back to the preset maxContext — large-context providers must not compact at 32k', () => {
    expect(resolveContextWindow(profile({ preset: 'nvidia-nim' }))).toBe(128_000);
    expect(resolveContextWindow(profile({ preset: 'openrouter' }))).toBe(128_000);
    expect(resolveContextWindow(profile({ preset: 'groq' }))).toBe(128_000);
  });

  it('capability override on the profile beats the preset default', () => {
    expect(
      resolveContextWindow(profile({ preset: 'openai', capabilities: { maxContext: 1_000_000 } })),
    ).toBe(1_000_000);
  });

  it('uses the conservative default when nothing is known (local presets)', () => {
    expect(resolveContextWindow(profile({ preset: 'ollama' }))).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveContextWindow(profile({}))).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});
