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
 * Four steps, each one thing, and the last one is a suggestion rather than a
 * form. Skippable at every point: someone who knows what they are doing should
 * not have to click through an explanation of it.
 */
export function Onboarding({
  profile,
  origin,
  site,
  onDone,
}: {
  profile: StoredProfile;
  origin: string;
  site?: ActiveSite;
  onDone: (profile: StoredProfile) => void;
}) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<StoredProfile>(profile);
  const [apiKey, setApiKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<Diagnosis | undefined>();
  const [granted, setGranted] = useState(site?.granted ?? false);
  const [useDebugger, setUseDebugger] = useState(true);

  const preset = presetById(draft.preset);

  const finish = async () => {
    await saveProfile(draft);
    if (apiKey.length > 0) await saveApiKey(apiKey);
    await saveUseDebugger(useDebugger);
    await saveOnboarded(true);
    onDone(draft);
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
      setResult(await diagnose(draft.baseUrl, origin, apiKey || undefined));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-steps" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className={index === step ? 'dot on' : 'dot'} />
        ))}
      </div>

      {step === 0 && (
        <>
          <h2>heapbrowse reads the page you are on, and can operate it for you.</h2>
          <p>
            Ask it what a page says, to compare things across tabs, or to fill in a form. It works
            in the tab you are looking at and shows you what it is about to do before it does it.
          </p>
          <h3>Where your data goes</h3>
          <p>
            The text of the pages you point it at is sent to <strong>the model endpoint you
            configure on the next screen, and nowhere else</strong>. There is no heapbrowse server.
            Point it at Ollama on your own machine and nothing leaves it at all.
          </p>
          <p className="muted">
            Your API key is stored on this device, never synced through your Chrome profile, and is
            never shown again once saved.
          </p>
          <div className="row">
            <button type="button" onClick={() => setStep(1)}>Set up the model</button>
            <button type="button" className="ghost" onClick={() => void skip()}>Skip</button>
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <h2>Which model should it use?</h2>
          <label>
            Provider
            <select
              value={draft.preset}
              onChange={(e) => {
                const id = e.target.value as PresetId;
                const next = presetById(id);
                const untouched = draft.baseUrl === presetById(draft.preset).defaultBaseUrl;
                setDraft({ ...draft, preset: id, baseUrl: untouched ? next.defaultBaseUrl : draft.baseUrl });
                setResult(undefined);
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
          {preset.apiKeyUrl && (
            <p className="muted">
              Get a key at{' '}
              <a href={preset.apiKeyUrl} target="_blank" rel="noreferrer noopener">
                {preset.apiKeyUrl}
              </a>
            </p>
          )}

          <div className="row">
            <button type="button" onClick={check} disabled={checking}>
              {checking ? 'Checking…' : 'Test connection'}
            </button>
            <button
              type="button"
              onClick={() => setStep(2)}
              disabled={draft.model.trim().length === 0}
            >
              Next
            </button>
          </div>
          {/* The Ollama case is why this is here rather than at the end: a local
              endpoint refuses an extension origin outright until OLLAMA_ORIGINS
              is set, and the browser reports that as an indistinguishable
              "failed to fetch" (PRD section 7.2). Finding that out on the first
              real question looks like a broken product. */}
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

          <h3>Reading a site</h3>
          <p>
            heapbrowse asks for one site at a time, when you point it at one — not for the whole web
            at install. You will see an &ldquo;Allow this site&rdquo; button in the header on any
            page it has not been granted.
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
          {site && granted && <p className="muted">{site.host} is allowed.</p>}

          <h3>Chrome&rsquo;s debugger</h3>
          <p>
            With it, heapbrowse reads the page the way the browser itself does, clicks with real
            input events that pages cannot tell from yours, sees inside embedded frames, and can
            attach a file. Without it, everything still works, but some sites ignore its clicks.
          </p>
          <p>
            <strong>Chrome shows a &ldquo;being debugged&rdquo; banner across the top of the window
            while a run is going.</strong> That is Chrome telling you the truth about what is
            attached, it cannot be hidden, and it disappears when the run ends. Opening DevTools on
            a tab takes the debugger away and heapbrowse falls back quietly.
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

          <div className="row">
            <button type="button" onClick={() => setStep(3)}>Next</button>
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <h2>Try one of these</h2>
          <ul className="suggestions">
            <li>&ldquo;What can I do on this page?&rdquo;</li>
            <li>&ldquo;Summarise this article in five points.&rdquo;</li>
            <li>&ldquo;What are the delivery options and how much do they cost?&rdquo;</li>
            <li>&ldquo;Search this site for wireless headphones under ₹5000.&rdquo;</li>
          </ul>
          <p className="muted">
            It starts in <strong>Ask every time</strong>: nothing happens to a page until you have
            approved it. The selector in the header loosens that when you want it to. Banks,
            brokerages and password managers can never be acted on, in any mode.
          </p>
          <p className="muted">
            If you fill in your name, email and address under Settings &rarr; Your details, it can
            fill in forms without asking you for them every time. It is never shown the values.
          </p>
          <div className="row">
            <button type="button" onClick={() => void finish()}>Start using it</button>
          </div>
        </>
      )}

      {step > 0 && step < 3 && (
        <button type="button" className="ghost" onClick={() => void skip()}>
          Skip setup
        </button>
      )}
    </div>
  );
}
