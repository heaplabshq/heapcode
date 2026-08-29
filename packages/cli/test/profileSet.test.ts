import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigStore } from '@heapcode/host';
import { PROFILE_FIELDS, isProfileField, profileSet } from '../src/profileCli.js';

/**
 * `heapcode profile set` — the CLI's only way to reach a profile's per-role
 * models. Onboarding covers the four fields a profile cannot work without;
 * everything else had no terminal surface at all, which meant `applyModel` —
 * edit_file's fallback, and worth the most on the small local models a
 * terminal user is likeliest to run — could only be set by hand-editing JSON.
 */

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'hcps-'));
  process.env.HEAPCODE_HOME = home;
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      activeProfile: 'local',
      profiles: [{ name: 'local', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama' }],
    }),
    'utf8',
  );
});

afterEach(async () => {
  delete process.env.HEAPCODE_HOME;
  await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const stored = async (): Promise<Record<string, unknown>> => {
  const cfg = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as {
    profiles: Array<Record<string, unknown>>;
  };
  return cfg.profiles.find((p) => p.name === 'local')!;
};

describe('profile set', () => {
  it('writes a role model', async () => {
    await profileSet('local', 'applyModel', 'fast-apply-1.5b');
    expect(await stored()).toMatchObject({ applyModel: 'fast-apply-1.5b' });
  });

  it('leaves every other field alone', async () => {
    await profileSet('local', 'applyModel', 'fast-apply');
    await profileSet('local', 'embeddingsModel', 'nomic-embed');
    expect(await stored()).toMatchObject({
      model: 'llama',
      baseUrl: 'http://localhost:11434/v1',
      applyModel: 'fast-apply',
      embeddingsModel: 'nomic-embed',
    });
  });

  it('clears the field when the value is omitted, rather than storing ""', async () => {
    // Empty string would point the role at a model with no name and fail much
    // later, at the provider. Absent means "inherit", which is the real intent.
    await profileSet('local', 'applyModel', 'fast-apply');
    await profileSet('local', 'applyModel', undefined);
    expect('applyModel' in (await stored())).toBe(false);
  });

  it('can point a role at another profile entirely', async () => {
    await profileSet('local', 'embeddingsProfile', 'other');
    expect(await stored()).toMatchObject({ embeddingsProfile: 'other' });
  });

  it('refuses an unknown profile instead of creating one', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await profileSet('nope', 'applyModel', 'x');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('No profile named'));
    expect(await new ConfigStore(join(home, 'config.json')).getProfile('nope')).toBeUndefined();
  });
});

describe('the settable field list', () => {
  it('covers every role model and its cross-profile redirect', () => {
    for (const role of ['agent', 'apply', 'edit', 'completion', 'embeddings', 'rerank', 'context']) {
      expect(PROFILE_FIELDS).toContain(`${role}Model`);
      expect(PROFILE_FIELDS).toContain(`${role}Profile`);
    }
  });

  it('rejects anything not on it, so a typo cannot write a junk key', () => {
    expect(isProfileField('applyModel')).toBe(true);
    expect(isProfileField('aplyModel')).toBe(false);
    expect(isProfileField('__proto__')).toBe(false);
  });
});

/**
 * Prompt detail, the one field here that is not free text.
 *
 * Every other settable field is a model id or a profile name, which this
 * command cannot check — a typo surfaces at the provider, eventually. This one
 * it can, and must: silently ignoring "leen" would leave the user believing
 * they had changed how the agent is prompted.
 */
describe('profile set promptTier', () => {
  it('stores a valid tier', async () => {
    await profileSet('local', 'promptTier', 'lean');
    expect(await stored()).toMatchObject({ promptTier: 'lean' });
  });

  it('stores auto, which is the derivation as an opt-in', async () => {
    await profileSet('local', 'promptTier', 'auto');
    expect(await stored()).toMatchObject({ promptTier: 'auto' });
  });

  it('refuses an invalid one, and says what is allowed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await profileSet('local', 'promptTier', 'leen');
    expect(err).toHaveBeenCalledWith(expect.stringContaining('full, lean, auto'));
    expect(await stored()).not.toHaveProperty('promptTier');
  });

  it('clears back to the default when the value is omitted', async () => {
    // Nothing stored means full, so there is no written-out 'full' to keep.
    await profileSet('local', 'promptTier', 'lean');
    await profileSet('local', 'promptTier');
    expect(await stored()).not.toHaveProperty('promptTier');
  });

  it('is on the settable list, so the usage line advertises it', () => {
    expect(PROFILE_FIELDS).toContain('promptTier');
  });
});
