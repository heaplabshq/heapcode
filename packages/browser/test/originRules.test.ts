import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOriginRules, syncOriginRules } from '../src/shared/originRules.js';
import type { StoredProfile } from '../src/shared/settings.js';

const ID = 'cbockgpkngiajhbhpidaolpneikomoeb';

const profile = (baseUrl: string, name = baseUrl): StoredProfile => ({ name, preset: 'ollama', baseUrl, model: 'm' });

describe('the rules that stop a self-hosted Ollama refusing us', () => {
  it('removes our Origin on requests to the configured endpoint, and nothing else', () => {
    const [rule, ...rest] = buildOriginRules(['http://192.168.29.132:11434/v1'], ID);
    expect(rest).toEqual([]);
    expect(rule!.action).toEqual({ type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] });
    // The exact origin, anchored — not the host, and not every port on it.
    expect(rule!.condition.urlFilter).toBe('|http://192.168.29.132:11434/');
  });

  it('only ever touches requests this extension started', () => {
    // Page Assist's rule was broader, and broke unrelated sites that talk to
    // local services. A web page calling the same Ollama must keep its Origin,
    // or Ollama's protection against drive-by pages is gone.
    for (const rule of buildOriginRules(['http://localhost:11434/v1', 'https://ollama.com/v1'], ID)) {
      expect(rule.condition.initiatorDomains).toEqual([ID]);
      expect(rule.condition.resourceTypes).not.toContain('main_frame');
      expect(rule.condition.resourceTypes).not.toContain('sub_frame');
    }
  });

  it('writes one rule per endpoint origin, however many profiles share it', () => {
    const rules = buildOriginRules(
      ['http://localhost:11434/v1', 'http://localhost:11434/v1/', 'http://localhost:1234/v1', 'https://ollama.com/v1'],
      ID,
    );
    expect(rules.map((r) => r.condition.urlFilter)).toEqual([
      '|http://localhost:11434/',
      '|http://localhost:1234/',
      '|https://ollama.com/',
    ]);
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
  });

  it('skips anything that is not an http(s) endpoint', () => {
    expect(buildOriginRules(['', 'not a url', 'file:///tmp/x', 'chrome-extension://abc/'], ID)).toEqual([]);
  });
});

describe('keeping the installed rules in step with the profiles', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubChrome(existing: number[]) {
    const updateDynamicRules = vi.fn(async () => undefined);
    vi.stubGlobal('chrome', {
      runtime: { id: ID },
      declarativeNetRequest: {
        getDynamicRules: vi.fn(async () => existing.map((id) => ({ id }))),
        updateDynamicRules,
      },
    });
    return updateDynamicRules;
  }

  it('replaces its own rules and leaves any other rule alone', async () => {
    // A removed profile must not leave its endpoint's rule behind; dynamic
    // rules survive restarts, so an append-only sync would accumulate them.
    const update = stubChrome([1000, 1001, 7]);
    await syncOriginRules([profile('http://192.168.29.132:11434/v1')]);
    expect(update).toHaveBeenCalledWith({
      removeRuleIds: [1000, 1001],
      addRules: [expect.objectContaining({ id: 1000, condition: expect.objectContaining({ urlFilter: '|http://192.168.29.132:11434/' }) })],
    });
  });

  it('clears every rule it owns when no profile is left', async () => {
    const update = stubChrome([1000]);
    await syncOriginRules([]);
    expect(update).toHaveBeenCalledWith({ removeRuleIds: [1000], addRules: [] });
  });
});
