/**
 * Why can't we reach the endpoint?
 *
 * A local Ollama refuses this extension by default. Ollama only sends
 * `Access-Control-Allow-Origin` for origins listed in `OLLAMA_ORIGINS`, our
 * origin is `chrome-extension://<id>`, and the manifest declares no
 * `host_permissions` that would let the fetch bypass CORS at all (PRD §7.2).
 * So the very first thing a local-first user does fails, and the browser tells
 * them almost nothing about why.
 *
 * The hard part is that "Ollama is not running" and "Ollama is running and
 * refusing our origin" are the *same* `TypeError: Failed to fetch` — the
 * response is opaque to script either way, deliberately, because leaking it
 * would make cross-origin port scanning trivial.
 *
 * A `no-cors` request separates them. It never yields a readable response, but
 * it does distinguish reachable from unreachable: the request is actually sent
 * and, if something answers, resolves to an opaque response instead of
 * throwing. Combined with the normal request:
 *
 *   normal ok                     → reachable and permitted
 *   normal throws, no-cors ok     → reachable, origin refused  → OLLAMA_ORIGINS
 *   both throw                    → nothing is listening there
 *
 * which is the difference between "run this one command" and "start Ollama".
 */

import { hasHostPermission, originPatternFor } from './hostPermission.js';

export type Diagnosis =
  | { kind: 'ok' }
  /**
   * Chrome has not been granted access to this origin, so the request is
   * subject to CORS and most endpoints will fail it. Checked first because it
   * is the one cause the user fixes with a click rather than a command.
   */
  | { kind: 'no-permission'; pattern: string }
  /** Something answered, but our origin is not allowed to read it. */
  | { kind: 'origin-blocked'; origin: string; fix: string }
  /** Nothing is listening at that address. */
  | { kind: 'unreachable'; baseUrl: string }
  /** Reachable and permitted, but the endpoint rejected us (bad key, wrong path). */
  | { kind: 'http-error'; status: number; body: string };

const PROBE_TIMEOUT_MS = 4000;

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * The command that fixes an origin-blocked local Ollama.
 *
 * Kept beside the diagnosis rather than in the UI because it is platform
 * specific and easy to get subtly wrong — `OLLAMA_ORIGINS` has to be set in the
 * environment the *server* runs in, which on macOS means `launchctl` for the
 * menu-bar app, not an `export` in the shell the user happens to have open.
 */
export function ollamaOriginsFix(origin: string, platform: string = navigator.platform): string {
  if (/mac/i.test(platform)) {
    return [
      `launchctl setenv OLLAMA_ORIGINS "${origin}"`,
      '# then quit and reopen the Ollama app so it picks the value up',
    ].join('\n');
  }
  if (/win/i.test(platform)) {
    return [`setx OLLAMA_ORIGINS "${origin}"`, '# then restart Ollama'].join('\n');
  }
  return [
    'systemctl edit --full ollama.service',
    `# add:  Environment="OLLAMA_ORIGINS=${origin}"`,
    'sudo systemctl restart ollama',
  ].join('\n');
}

/**
 * Probe `baseUrl` and say what is wrong in terms the user can act on.
 *
 * `origin` is the extension's own origin, which the panel gets from the worker
 * — `chrome.runtime.id` is not knowable at build time.
 */
export async function diagnose(
  baseUrl: string,
  origin: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
  permitted: (url: string) => Promise<boolean> = hasHostPermission,
): Promise<Diagnosis> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // Ask before probing. Without the grant the request is CORS-checked and most
  // endpoints fail it, which would surface below as `unreachable` — sending the
  // user to restart a server that was running the whole time.
  if (!(await permitted(baseUrl))) {
    return { kind: 'no-permission', pattern: originPatternFor(baseUrl) ?? baseUrl };
  }

  const first = withTimeout(PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { headers, signal: first.signal });
    if (response.ok) return { kind: 'ok' };
    // We were allowed to read the response, so connectivity is fine and the
    // endpoint itself is objecting.
    //
    // A 403 with no key sent is Ollama refusing the origin: it rejects a
    // `chrome-extension://` origin server-side, independently of what Chrome
    // permits, so this survives even once the host grant is in place. Reading
    // it as a credential problem would send the user to check a key that the
    // endpoint never asked for.
    if (response.status === 403 && !apiKey) {
      return { kind: 'origin-blocked', origin, fix: ollamaOriginsFix(origin) };
    }
    const body = await response.text().catch(() => '');
    return { kind: 'http-error', status: response.status, body: body.slice(0, 400) };
  } catch {
    // Opaque: could be refused-origin or nothing-listening. Ask again without
    // CORS, where only reachability decides the outcome.
  } finally {
    first.done();
  }

  const second = withTimeout(PROBE_TIMEOUT_MS);
  try {
    await fetchImpl(url, { mode: 'no-cors', signal: second.signal });
    return { kind: 'origin-blocked', origin, fix: ollamaOriginsFix(origin) };
  } catch {
    return { kind: 'unreachable', baseUrl };
  } finally {
    second.done();
  }
}

/** One-line summary for the panel; the fix text is rendered separately. */
export function describe(diagnosis: Diagnosis): string {
  switch (diagnosis.kind) {
    case 'ok':
      return 'Connected.';
    case 'no-permission':
      return `Chrome has not granted this extension access to ${diagnosis.pattern}. Press Allow on the prompt — without it the browser blocks the request before it is sent.`;
    case 'origin-blocked':
      return `Reachable, but it is refusing this extension's origin (${diagnosis.origin}). Ollama only answers origins listed in OLLAMA_ORIGINS.`;
    case 'unreachable':
      return `Nothing is listening at ${diagnosis.baseUrl}. Check the server is running and the base URL is right.`;
    case 'http-error':
      return `The endpoint answered ${diagnosis.status}. ${
        diagnosis.status === 401 || diagnosis.status === 403
          ? 'That usually means the API key is missing or wrong.'
          : 'Check the base URL ends in /v1.'
      }`;
  }
}
