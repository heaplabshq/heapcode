import { useEffect, useState } from 'react';
import {
  describeWebSearchState,
  getSearchPreset,
  isSearchPresetId,
  searchPresets,
  type SearchPresetId,
  type WebSearchConfig,
} from '@heapcode/core/agent';
import {
  loadWebSearchApiKey,
  loadWebSearchConfig,
  saveWebSearchApiKey,
  saveWebSearchConfig,
} from '../../shared/settings.js';
import { hasHostPermission, requestHostPermission } from '../../shared/hostPermission.js';
import { Icon } from './Icon.js';

/**
 * Web search setup, as its own card.
 *
 * The agent gets web_search only when this is configured, so the card is the
 * whole on-switch: a provider, the endpoint when the preset needs one, and the
 * key when the provider does. Core owns every behaviour behind it (the
 * presets, the per-backend request shapes, the disabled notice) — this is the
 * same shape the CLI's `/websearch` command and the editor's settings configure.
 *
 * The key field is write-only for the same reason the provider key is: stored
 * on save, never read back into the form, so nothing that renders this panel
 * can exfiltrate a stored key and it never appears in a screenshot.
 *
 * Saving requests the endpoint's origin like the provider card does. Search
 * APIs send no CORS headers for an extension origin (see hostPermission.ts),
 * so without the grant every search would fail with the indistinguishable
 * "Failed to fetch" — and `permissions.request` only works inside a user
 * gesture, which is why the request hangs off this button and not an effect.
 */
export function WebSearchCard() {
  const [provider, setProvider] = useState<SearchPresetId>('duckduckgo');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  /** The one-line verdict from core, refreshed after load and after save. */
  const [status, setStatus] = useState('');
  const [saved, setSaved] = useState(false);

  const preset = getSearchPreset(provider);

  const refreshStatus = async () => {
    const [config, key] = await Promise.all([loadWebSearchConfig(), loadWebSearchApiKey()]);
    // The key is passed to core and never rendered; `describeWebSearchState`
    // returns only a verdict like "on (DuckDuckGo)".
    setStatus(describeWebSearchState(config, key));
  };

  useEffect(() => {
    void (async () => {
      const config = await loadWebSearchConfig();
      if (config?.provider && isSearchPresetId(config.provider)) setProvider(config.provider);
      setBaseUrl(config?.baseUrl ?? '');
      await refreshStatus();
    })();
  }, []);

  const save = async () => {
    const endpoint = baseUrl.trim() || preset.defaultBaseUrl;
    if (endpoint && !(await hasHostPermission(endpoint))) await requestHostPermission(endpoint);
    const config: WebSearchConfig = {
      provider,
      ...(baseUrl.trim() && baseUrl.trim() !== preset.defaultBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
    };
    await saveWebSearchConfig(config);
    if (apiKey.length > 0) {
      await saveWebSearchApiKey(apiKey);
      setApiKey('');
    }
    await refreshStatus();
    setSaved(true);
  };

  return (
    <section className="settings-card">
      <header className="settings-card-head">
        <span className="settings-card-icon" aria-hidden="true">
          <Icon name="find" />
        </span>
        <h3 className="section-title">Web search</h3>
      </header>
      <div className="settings-card-body">
        <label>
          Search provider
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as SearchPresetId)}
          >
            {searchPresets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.selfHosted ? ' (self-hosted)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label>
          Base URL {preset.defaultBaseUrl ? '' : '(required for this provider)'}
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={preset.defaultBaseUrl}
            spellCheck={false}
          />
        </label>

        <label>
          API key {preset.requiresApiKey ? '' : '(not needed for this provider)'}
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="stored locally, never synced"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <p className="muted">{preset.hint}</p>
        <p className="muted">
          {saved ? 'Saved. ' : ''}
          Status: {status || 'disabled (no search provider configured)'}.
        </p>

        <button type="button" className="ghost" onClick={save}>
          Save web search
        </button>
      </div>
    </section>
  );
}