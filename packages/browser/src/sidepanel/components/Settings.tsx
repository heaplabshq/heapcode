import { useEffect, useState } from 'react';
import type { PresetId } from '@heapcode/core/providers';
import {
  addProfile,
  deleteProfile,
  loadFiles,
  loadProfiles,
  loadUseDebugger,
  needsApiKey,
  presetById,
  presets,
  saveApiKey,
  saveFiles,
  saveProfile,
  saveUseDebugger,
  setActiveProfile,
  type StoredProfile,
} from '../../shared/settings.js';
import { debuggerAvailable } from '../../agent/cdp.js';
import { describe, diagnose, type Diagnosis } from '../../shared/ollamaDiagnostic.js';
import { hasHostPermission, requestHostPermission } from '../../shared/hostPermission.js';
import { Details } from './Details.js';

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
  const [useDebugger, setUseDebugger] = useState(false);
  const [files, setFiles] = useState('');
  const [profiles, setProfiles] = useState<StoredProfile[]>([]);

  useEffect(() => {
    void loadUseDebugger().then(setUseDebugger);
    void loadFiles().then((paths) => setFiles(paths.join('\n')));
    void loadProfiles().then(setProfiles);
  }, []);

  /**
   * Switch to another configured endpoint.
   *
   * The draft is replaced wholesale and the key field cleared: a key typed
   * against one profile must never be saved into another, and the field is
   * write-only so there is nothing to carry across anyway.
   */
  const choose = async (name: string) => {
    const wanted = profiles.find((profile) => profile.name === name);
    if (!wanted) return;
    await setActiveProfile(name);
    setDraft(wanted);
    setApiKey('');
    setResult(undefined);
    onSaved(wanted);
  };

  /**
   * Just a preference now.
   *
   * There is no permission to request: Chrome refuses to let `debugger` be
   * optional, so it is held from install or not at all. The runtime grant flow
   * this replaced could never have worked -- `permissions.request` throws for a
   * permission the manifest does not declare as optional, which is why the
   * switch would not stay ticked.
   */
  const toggleDebugger = async (wanted: boolean) => {
    setUseDebugger(wanted);
    await saveUseDebugger(wanted);
  };

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
      // Named explicitly: the key belongs to the profile being saved, which is
      // not necessarily the one that was active when the field was typed into.
      await saveApiKey(apiKey, draft.name);
      setApiKey('');
    }
    setProfiles(await loadProfiles());
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
      {profiles.length > 0 && (
        <div className="profiles">
          <label>
            Profile
            <select value={draft.name} onChange={(e) => void choose(e.target.value)}>
              {profiles.map((profile) => (
                <option key={profile.name} value={profile.name}>
                  {profile.name}
                  {profile.model ? ` — ${profile.model}` : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button
              type="button"
              className="ghost"
              onClick={async () => {
                const next = await addProfile(draft);
                setProfiles(next);
                const created = next[next.length - 1]!;
                setDraft(created);
                setApiKey('');
                onSaved(created);
              }}
            >
              Duplicate
            </button>
            {profiles.length > 1 && (
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  const next = await deleteProfile(draft.name);
                  setProfiles(next);
                  setDraft(next[0]!);
                  setApiKey('');
                  onSaved(next[0]!);
                }}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      )}

      <label>
        Name
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="local, work, big model…"
          spellCheck={false}
        />
      </label>

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

      <hr className="rule" />

      <label className="switch">
        <input
          type="checkbox"
          aria-label="Use Chrome's debugger"
          checked={useDebugger}
          onChange={(e) => void toggleDebugger(e.target.checked)}
        />
        Use Chrome&rsquo;s debugger
      </label>
      <p className="muted">
        Reads the page the way the browser itself does, clicks with real input events, and can
        attach files. Chrome shows a &ldquo;being debugged&rdquo; banner while a run is going, and
        opening DevTools on the tab switches it back off.
      </p>
      {useDebugger && !debuggerAvailable() && (
        <p className="turn-error">
          This build does not have the debugger permission, so the page will be read the older way.
        </p>
      )}

      {useDebugger && (
        <label>
          Files the agent may attach — one full path per line
          <textarea
            value={files}
            onChange={(e) => setFiles(e.target.value)}
            onBlur={() => void saveFiles(files.split('\n').map((line) => line.trim()))}
            placeholder="/Users/you/Documents/CV.pdf"
            rows={2}
            spellCheck={false}
          />
        </label>
      )}

      <hr className="rule" />

      <details className="disclosure">
        <summary>Your details</summary>
        <Details />
      </details>

      <hr className="rule" />

      <details className="disclosure">
        <summary>Where your data goes</summary>
        <p className="muted">
          The text of the pages you point heapbrowse at is sent to the endpoint configured above,
          and nowhere else. There is no heapbrowse server. Your API key and your saved details are
          stored on this device, never synced through your Chrome profile.
        </p>
      </details>

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
