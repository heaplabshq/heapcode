import { useState } from 'react';
import type { PresetId } from '@heapcode/core/providers';
import {
  needsApiKey,
  presetById,
  presets,
  saveApiKey,
  saveOnboarded,
  saveProfile,
  saveUseDebugger,
  type StoredProfile,
} from '../../shared/settings.js';
import { describe, diagnose, type Diagnosis } from '../../shared/ollamaDiagnostic.js';
import { hasHostPermission, requestHostPermission } from '../../shared/hostPermission.js';
import { grantActiveSite, type ActiveSite } from '../page.js';
import { Icon } from './Icon.js';
import { ModelField } from './ModelField.js';

/**
 * The first three minutes.
 *
 * Before this there was none: a new install opened Settings if no model was
 * configured, and that was the whole of it. Someone who had not built the thing
 * had no way to learn that page content goes to an endpoint they choose, that a
 * local Ollama needs an environment variable set before it will answer an
 * extension at all, that reading a site is granted per site, or what the
 * &ldquo;being debugged&rdquo; banner across the top of their browser means. Each of
 * those is a question that gets asked once and then never again -- which is
 * exactly what an onboarding is for, and exactly what a settings page is bad at.
 *
 * Four steps, each one thing. Skippable at every point, and reversible: someone
 * who realises on the permissions screen that they mistyped the base URL should
 * be able to go back to it rather than skipping out and finding Settings. The
 * last step is a suggestion rather than a form, and pressing one of those
 * suggestions both finishes setup and starts the first run -- the shortest
 * honest path from install to the product doing something.
 */

const STEPS = 4;

export function Onboarding({
  profile,
  origin,
  site,
  onDone,
}: {
  profile: StoredProfile;
  origin: string;
  site?: ActiveSite;
  /** `firstPrompt` is set when the user finished by pressing a suggestion. */
  onDone: (profile: StoredProfile, firstPrompt?: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<StoredProfile>(profile);
  const [apiKey, setApiKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Diagnosis | undefined>();
  const [granted, setGranted] = useState(site?.granted ?? false);
  const [useDebugger, setUseDebugger] = useState(true);
  /** What the endpoint says it can run. Filled in by the connection check. */
  const [models, setModels] = useState<string[]>([]);

  const preset = presetById(draft.preset);

  const finish = async (firstPrompt?: string) => {
    await saveProfile(draft);
    if (apiKey.length > 0) await saveApiKey(apiKey);
    await saveUseDebugger(useDebugger);
    await saveOnboarded(true);
    onDone(draft, firstPrompt);
  };

  const skip = async () => {
    await saveOnboarded(true);
    onDone(draft);
  };

  const ensureAccess = async () => {
    if (await hasHostPermission(draft.baseUrl)) return true;
    return requestHostPermission(draft.baseUrl);
  };

  const check = async () => {
    setChecking(true);
    setResult(undefined);
    try {
      await ensureAccess();
      const diagnosis = await diagnose(draft.baseUrl, origin, apiKey || undefined);
      setResult(diagnosis);
      if (diagnosis.kind !== 'ok') return;
      setModels(diagnosis.models);
      // Nothing chosen yet and exactly one thing to choose is not a decision.
      if (!draft.model.trim() && diagnosis.models.length === 1) {
        setDraft((current) => ({ ...current, model: diagnosis.models[0]! }));
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-head">
        {step > 0 ? (
          <button
            type="button"
            className="icon-button"
            onClick={() => setStep((s) => s - 1)}
            aria-label="Back a step"
          >
            <Icon name="arrowLeft" />
          </button>
        ) : (
          <span className="brand-mark" aria-hidden="true" />
        )}
        <div className="onboarding-track" aria-hidden="true">
          {Array.from({ length: STEPS }, (_, index) => (
            <span
              key={index}
              className={`seg${index === step ? ' on' : index < step ? ' done' : ''}`}
            />
          ))}
        </div>
        <span className="onboarding-count">
          {step + 1}/{STEPS}
        </span>
      </div>

      {/* Keyed on the step so React remounts it, which is what replays the
          entry animation. A step that slid in on the way forward and simply
          swapped on the way back read as a rendering glitch. */}
      <div className="onboarding-body" key={step}>
        {step === 0 && (
          <>
            <span className="hero-mark" aria-hidden="true" />
            <h2>heapbrowse reads the page you are on, and can operate it for you.</h2>
            <ul className="value-list">
              <li>
                <span className="value-icon">
                  <Icon name="read" />
                </span>
                <span>
                  <strong>Ask about what is in front of you</strong>
                  What a page says, what the options cost, what you can do here.
                </span>
              </li>
              <li>
                <span className="value-icon">
                  <Icon name="pointer" />
                </span>
                <span>
                  <strong>Let it do the clicking</strong>
                  Search, filter, fill in a form — and it shows you each action before it takes
                  one.
                </span>
              </li>
              <li>
                <span className="value-icon">
                  <Icon name="lock" />
                </span>
                <span>
                  <strong>Your pages go where you say</strong>
                  To the model endpoint you configure next, and nowhere else. There is no
                  heapbrowse server for your pages; point it at Ollama and no page you read leaves
                  this machine.
                </span>
              </li>
            </ul>
            <p className="muted">
              Your API key is stored on this device, never synced through your Chrome profile, and
              never shown again once saved.
            </p>
            <p className="muted">
              heapbrowse does send anonymous counts &mdash; how often it runs, which tools it used,
              how runs ended &mdash; so we can tell what is working. Never the pages you visit, the
              sites you are on, what you asked for, or anything you have saved. You can switch it
              off in Settings at any time.
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <h2>Which model should it use?</h2>
            <div className="field-group">
              <label>
                Provider
                <select
                  value={draft.preset}
                  onChange={(e) => {
                    const id = e.target.value as PresetId;
                    const next = presetById(id);
                    const untouched = draft.baseUrl === presetById(draft.preset).defaultBaseUrl;
                    setDraft({
                      ...draft,
                      preset: id,
                      baseUrl: untouched ? next.defaultBaseUrl : draft.baseUrl,
                    });
                    setResult(undefined);
                    // The list belonged to the endpoint being left.
                    setModels([]);
                  }}
                >
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
                  onChange={(e) => {
                    setDraft({ ...draft, baseUrl: e.target.value });
                    setModels([]);
                  }}
                  spellCheck={false}
                />
              </label>

              <ModelField
                value={draft.model}
                models={models}
                onChange={(model) => setDraft({ ...draft, model })}
                placeholder={draft.preset === 'ollama' ? 'llama3.1' : 'gpt-4o-mini'}
              />

              {needsApiKey(draft) && (
                <label>
                  API key
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="stored locally, never synced"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>
              )}
            </div>

            {preset.apiKeyUrl && (
              <p className="muted">
                Get a key at{' '}
                <a href={preset.apiKeyUrl} target="_blank" rel="noreferrer noopener">
                  {preset.apiKeyUrl}
                </a>
              </p>
            )}

            <button type="button" onClick={check} disabled={checking}>
              {checking ? 'Checking…' : 'Test connection'}
            </button>

            {/* The Ollama case is why this is here rather than at the end: a
                local endpoint refuses an extension origin outright until
                OLLAMA_ORIGINS is set, and the browser reports that as an
                indistinguishable "failed to fetch" (PRD section 7.2). Finding
                that out on the first real question looks like a broken
                product. */}
            {result && (
              <div className={`diagnosis ${result.kind}`}>
                <p>{describe(result)}</p>
                {result.kind === 'origin-blocked' && (
                  <>
                    <p className="muted">Run this, then test again:</p>
                    <pre>{result.fix}</pre>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h2>Two permissions, and what they cost</h2>

            <div className="perm-card">
              <div className="perm-head">
                <h3>Reading a site</h3>
                {granted ? (
                  <span className="state on">
                    <Icon name="check" size={11} />
                    allowed
                  </span>
                ) : (
                  <span className="state">not yet</span>
                )}
              </div>
              <p className="muted">
                One site at a time, when you point it at one — not the whole web at install. On any
                page it has not been granted you will see an &ldquo;Allow this site&rdquo; button in
                the header.
              </p>
              {site && !granted && (
                <button
                  type="button"
                  onClick={async () => {
                    if (await grantActiveSite()) setGranted(true);
                  }}
                >
                  Allow {site.host} now
                </button>
              )}
            </div>

            <div className="perm-card">
              <div className="perm-head">
                <h3>Chrome&rsquo;s debugger</h3>
                <span className={useDebugger ? 'state on' : 'state'}>
                  {useDebugger ? (
                    <>
                      <Icon name="check" size={11} />
                      on
                    </>
                  ) : (
                    'off'
                  )}
                </span>
              </div>
              <p className="muted">
                With it, heapbrowse reads the page the way the browser itself does, clicks with real
                input events that pages cannot tell from yours, sees inside embedded frames, and can
                attach a file. Without it everything still works, but some sites ignore its clicks.
              </p>
              <p className="muted">
                <strong>Chrome shows a &ldquo;being debugged&rdquo; banner across the top of the
                window while a run is going.</strong> That is Chrome telling you the truth about
                what is attached, it cannot be hidden, and it disappears when the run ends.
                heapbrowse puts its own bar along the bottom of the page saying what it is actually
                doing. Opening DevTools on a tab takes the debugger away and heapbrowse falls back
                quietly.
              </p>
              <label className="switch">
                <input
                  type="checkbox"
                  aria-label="Use Chrome's debugger"
                  checked={useDebugger}
                  onChange={(e) => setUseDebugger(e.target.checked)}
                />
                Use Chrome&rsquo;s debugger (recommended)
              </label>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2>Try one of these</h2>
            <p className="muted">Pressing one finishes setup and runs it.</p>
            <div className="pills left">
              {[
                'What can I do on this page?',
                'Summarise this page in five points',
                'What are the delivery options and how much do they cost?',
                'Search this site for wireless headphones under ₹5000',
              ].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="pill"
                  onClick={() => void finish(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
            <p className="muted">
              It starts in <strong>Ask every time</strong>: nothing happens to a page until you have
              approved it. The control beside the send button loosens that when you want it to.
              Banks, brokerages and password managers can never be acted on, in any mode.
            </p>
            <p className="muted">
              If you fill in your name, email and address under Settings &rarr; Your details, it can
              fill in forms without asking you for them every time. It is never shown the values.
            </p>
          </>
        )}
      </div>

      <div className="onboarding-foot">
        {step < STEPS - 1 && (
          <button type="button" className="ghost" onClick={() => void skip()}>
            Skip setup
          </button>
        )}
        <span className="grow" />
        {step === 0 && (
          <button type="button" className="primary" onClick={() => setStep(1)}>
            Set up the model
          </button>
        )}
        {step === 1 && (
          <button
            type="button"
            className="primary"
            onClick={() => setStep(2)}
            disabled={draft.model.trim().length === 0}
          >
            Next
          </button>
        )}
        {step === 2 && (
          <button type="button" className="primary" onClick={() => setStep(3)}>
            Next
          </button>
        )}
        {step === 3 && (
          <button type="button" className="primary" onClick={() => void finish()}>
            Start using it
          </button>
        )}
      </div>
    </div>
  );
}
