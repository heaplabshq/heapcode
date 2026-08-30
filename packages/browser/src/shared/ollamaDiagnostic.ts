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

import { isLoopback, isOriginRefused } from '@heapcode/core/providers';
import { hasHostPermission, originPatternFor } from './hostPermission.js';

export type Diagnosis =
  /**
   * Reachable, permitted, and here is what it will answer as.
   *
   * The probe already asks `/models` -- that is what makes it a connectivity
   * check at all -- so the answer is parsed rather than thrown away. Testing
   * the connection and finding out what you can run are the same question
   * asked once, which is why the model field is a list the moment the check
   * passes instead of a box you have to know what to type into.
   *
   * Empty when the endpoint answered in a shape we do not recognise. That is
   * not a failure: plenty of gateways serve chat completions perfectly well
   * and list nothing, so the field falls back to being typed in.
   */
  | { kind: 'ok'; models: string[] }
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
 * Turns core's origin-refusal error into something the user can act on.
 *
 * Core can say *that* a local server refused the origin — it sees the 403, the
 * empty body and the loopback address — but not what to do about it. The two
 * missing halves live here: the origin, which is `chrome-extension://<id>` and
 * so is not knowable until install, and the command, which differs per
 * platform and has to reach the environment the *server* runs in.
 *
 * Appended to the run's error text rather than raised as its own UI. It is the
 * same advice the connection check gives, and the run is just as likely to be
 * where someone meets it first — a profile set up weeks ago, working right up
 * until the first question that needed the model.
 */
export function withOriginFix(text: string, origin: string, platform?: string): string {
  if (!isOriginRefused(text)) return text;
  const fix = platform === undefined ? ollamaOriginsFix(origin) : ollamaOriginsFix(origin, platform);
  return `${text}\n\nAdd this extension to its allow list, then restart Ollama:\n\n${fix}`;
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
    if (response.ok) return { kind: 'ok', models: parseModels(await response.text()) };
    // We were allowed to read the response, so connectivity is fine and the
    // endpoint itself is objecting.
    //
    // A 403 is Ollama refusing the origin: it rejects a `chrome-extension://`
    // origin server-side, independently of what Chrome permits, so this
    // survives even once the host grant is in place. Reading it as a
    // credential problem would send the user to check a key that the endpoint
    // never asked for.
    //
    // Judged on the silence, not on whether a key was sent. Ollama implements
    // no key at all, so people put a placeholder in the field because a key box
    // looks required — and that alone used to route them to the http-error
    // branch, which blames the key. What actually separates the two is that
    // Ollama's refusal says nothing: a server rejecting a real credential
    // explains itself, and every hosted one does.
    //
    // The address still has to agree, so that a hosted endpoint answering an
    // expired key with an empty 403 is not sent to edit OLLAMA_ORIGINS. A
    // loopback address is Ollama however it was configured; anywhere else, a
    // key having been sent means the endpoint is one that wants keys.
    const body = await response.text().catch(() => '');
    if (response.status === 403 && !body.trim() && (isLoopback(baseUrl) || !apiKey)) {
      return { kind: 'origin-blocked', origin, fix: ollamaOriginsFix(origin) };
    }
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

/**
 * The model names in a `/models` response.
 *
 * Two shapes, because the two endpoints a user of this actually points at do
 * not agree: OpenAI-compatible servers answer `{ data: [{ id }] }`, and
 * Ollama's own API answers `{ models: [{ name }] }`. Anything else yields
 * nothing, and nothing is a fine answer -- the field falls back to being typed.
 *
 * Deliberately total: a malformed body from an endpoint the user typed the
 * address of must not turn a working connection into a thrown error.
 */
export function parseModels(body: string): string[] {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return [];
    const record = parsed as { data?: unknown; models?: unknown };
    const rows = Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : [];
    const names = rows
      .map((row) => {
        if (typeof row === 'string') return row;
        if (!row || typeof row !== 'object') return undefined;
        const entry = row as { id?: unknown; name?: unknown };
        if (typeof entry.id === 'string') return entry.id;
        if (typeof entry.name === 'string') return entry.name;
        return undefined;
      })
      .filter((name): name is string => Boolean(name));
    // Sorted and de-duplicated: a provider that lists two hundred models in
    // insertion order is a list nobody can find anything in.
    return [...new Set(names)].sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Just the model list, for a picker that does not need the whole diagnosis.
 *
 * Silent on every failure. The composer's model picker refreshes itself in the
 * background; a provider that is briefly unreachable should leave the list as
 * it was, not put an error in front of someone who was doing something else.
 */
export async function listModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    if (!(await hasHostPermission(baseUrl))) return [];
    const { signal, done } = withTimeout(PROBE_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers, signal });
      if (!response.ok) return [];
      return parseModels(await response.text());
    } finally {
      done();
    }
  } catch {
    return [];
  }
}

/** One-line summary for the panel; the fix text is rendered separately. */
export function describe(diagnosis: Diagnosis): string {
  switch (diagnosis.kind) {
    case 'ok':
      return diagnosis.models.length > 0
        ? `Connected. ${diagnosis.models.length} model${diagnosis.models.length === 1 ? '' : 's'} available.`
        : 'Connected. It did not list its models, so type the name yourself.';
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
