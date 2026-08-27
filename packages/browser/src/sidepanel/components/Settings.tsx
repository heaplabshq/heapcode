import { useState } from 'react';
import type { PresetId } from '@heapcode/core/providers';
import {
  needsApiKey,
  presetById,
  presets,
  saveApiKey,
  saveProfile,
  type StoredProfile,
} from '../../shared/settings.js';
import { describe, diagnose, type Diagnosis } from '../../shared/ollamaDiagnostic.js';
import { hasHostPermission, requestHostPermission } from '../../shared/hostPermission.js';

/**
 * Provider setup, plus the connectivity check.
 *
 * The check is not decoration. A local-first user's first action is pointing
 * this at `http://localhost:11434/v1`, and it fails — Ollama refuses origins
 * that are not in `OLLAMA_ORIGINS`, and the browser reports that as an
 * indistinguishable "Failed to fetch" (PRD §7.2). Without this the product
 * looks broken at minute one for exactly the users it is aimed at.
 *
 * The key field is write-only. It is stored on save and never read back into
 * the form, so a stored key cannot be exfiltrated by anything that gets to
 * render this panel, and it never appears in a screenshot.
 */
export function Settings({
  profile,
  origin,
  onSaved,
}: {
  profile: StoredProfile;
  origin: string;
  onSaved: (profile: StoredProfile) => void;
}) {
  const [draft, setDraft] = useState<StoredProfile>(profile);
  const [apiKey, setApiKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Diagnosis | undefined>();

  const preset = presetById(draft.preset);

  const choosePreset = (id: PresetId) => {
    const next = presetById(id);
    // Carry the base URL across only when the user had not customised it, so
    // switching presets to compare them does not silently discard a hand-typed
    // endpoint.
    const untouched = draft.baseUrl === presetById(draft.preset).defaultBaseUrl;
    setDraft({
      ...draft,
      preset: id,
      baseUrl: untouched ? next.defaultBaseUrl : draft.baseUrl,
    });
    setResult(undefined);
  };

  /**
   * Chrome must grant access to the endpoint before any request reaches it, and
   * `permissions.request` only works inside a user gesture — so it hangs off
   * these buttons rather than off an effect. Asking again when the grant is
   * already held would show a redundant prompt, hence the check first.
   */
  const ensureAccess = async (): Promise<boolean> => {
    if (await hasHostPermission(draft.baseUrl)) return true;
    return requestHostPermission(draft.baseUrl);
  };

  const save = async () => {
    await ensureAccess();
    await saveProfile(draft);
    if (apiKey.length > 0) {
      await saveApiKey(apiKey);
      setApiKey('');
    }
    onSaved(draft);
  };

  const check = async () => {
    setChecking(true);
    setResult(undefined);
    try {
      await ensureAccess();
      // Use the key being typed if there is one, so the check reflects the form
      // rather than what was last saved.
      setResult(await diagnose(draft.baseUrl, origin, apiKey || undefined));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="settings">
      <label>
        Provider
        <select value={draft.preset} onChange={(e) => choosePreset(e.target.value as PresetId)}>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.local ? ' (local)' : ''}
            </option>
          ))}
        </select>
      </label>

      <label>
        Base URL
        <input
          value={draft.baseUrl}
          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          spellCheck={false}
        />
      </label>

      <label>
        Model
        <input
          value={draft.model}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          placeholder={draft.preset === 'ollama' ? 'llama3.1' : 'gpt-4o-mini'}
          spellCheck={false}
        />
      </label>

      <label>
        API key {needsApiKey(draft) ? '' : '(not needed for this provider)'}
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="stored locally, never synced"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {preset.apiKeyUrl && (
        <p className="muted">
          Get a key at <a href={preset.apiKeyUrl} target="_blank" rel="noreferrer noopener">{preset.apiKeyUrl}</a>
        </p>
      )}

      <div className="row">
        <button type="button" onClick={save}>Save</button>
        <button type="button" onClick={check} disabled={checking}>
          {checking ? 'Checking…' : 'Test connection'}
        </button>
      </div>

      {result && (
        <div className={`diagnosis ${result.kind}`}>
          <p>{describe(result)}</p>
          {result.kind === 'origin-blocked' && (
            <>
              <p className="muted">Run this, then try again:</p>
              <pre>{result.fix}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
