/**
 * Anonymous usage counts.
 *
 * Event names and coarse metadata, and deliberately nothing else. No page
 * content, no URLs, no hosts, no prompts, no answers, no provider addresses, no
 * API keys, no saved details. The rule is not "we strip the sensitive parts" --
 * it is that nothing which varies with what the user is doing on the web ever
 * enters an event, so there is nothing to strip. `track()` takes a name from a
 * fixed list and a small object of enums and counts.
 *
 * On by default, with a switch in Settings and a plain statement of it in the
 * first screen of onboarding and in the privacy policy. That is a real trade
 * and it is worth naming: heapbrowse's pitch is that the page you are looking
 * at goes to the endpoint you chose and nowhere else, and that promise is
 * unchanged by this -- but "nothing leaves at all" was simpler to explain, and
 * it is no longer the whole truth. Hence the disclosure in three places rather
 * than one, and hence the tight event vocabulary below: the defence for an
 * opt-out default is that there is provably nothing personal in it.
 *
 * Sent fire-and-forget with `mode: 'no-cors'`. That costs the response -- we
 * cannot see whether the collector accepted it -- and buys the absence of a
 * host permission for the collector's origin, which would otherwise appear in
 * the install prompt as "read and change your data on ...". A permission line
 * at install, for counting, would be a bad trade for a product that just spent
 * a milestone removing two of them.
 */

// Shared collector -- one Worker for every heaplabs app, partitioned by `app`.
// https://github.com/heaplabshq/heaplabs-telemetry
const ENDPOINT = 'https://heaplabs-telemetry.y5ghjsdc4n.workers.dev/v1/events';
const APP = 'heapbrowse';

const ENABLED_KEY = 'heapbrowse.telemetryEnabled';
const ANON_ID_KEY = 'heapbrowse.telemetryAnonId';

const FLUSH_AFTER = 10;
const FLUSH_INTERVAL_MS = 60_000;
const MAX_QUEUE = 50;

/**
 * The whole vocabulary.
 *
 * A closed union rather than a free string, so adding an event is a change
 * someone reviews rather than something a call site can do on its own. Every
 * one of these answers a question about the product working, never about what
 * the user was doing.
 */
export type TelemetryEvent =
  | 'onboarding_started'
  | 'onboarding_finished'
  | 'onboarding_skipped'
  | 'run_started'
  | 'run_finished'
  | 'tool_used'
  | 'confirmation_answered'
  | 'provider_check';

/** Coarse, non-identifying detail. Numbers and enums only -- never free text. */
export interface TelemetryMeta {
  /** A tool name, from our own fixed belt. Never an argument. */
  tool?: string;
  /** `ollama`, `openai`, ... -- the preset name, never the base URL. */
  preset?: string;
  /** `read-only` | `confirm` | `auto-approve` | `auto`. */
  mode?: string;
  /** `cdp` | `dom`. */
  driver?: string;
  /** `done` | `stopped` | `error` | `incomplete`. */
  outcome?: string;
  /** `allow` | `always` | `deny`. */
  answer?: string;
  /** `write` | `destructive` | `read`. */
  permission?: string;
  /** How many steps a run took. A count, not a transcript. */
  steps?: number;
  ok?: boolean;
}

interface QueuedEvent {
  name: TelemetryEvent;
  ts: number;
  meta?: TelemetryMeta;
}

export async function loadTelemetryEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(ENABLED_KEY);
  return stored[ENABLED_KEY] !== false;
}

export async function saveTelemetryEnabled(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_KEY]: value });
  if (!value) {
    // Anything already queued is dropped rather than sent: switching it off
    // should not be followed by one last upload of what came before.
    queue.length = 0;
    // The identifier goes too. Turning it back on later starts a new one, so
    // the switch cannot be used to link two periods of use together.
    await chrome.storage.local.remove(ANON_ID_KEY);
  }
}

/**
 * A stable random identifier, so counts can be de-duplicated per install.
 *
 * Generated locally, never derived from anything about the machine or the
 * person, and removed the moment telemetry is switched off.
 */
async function anonId(): Promise<string> {
  const stored = await chrome.storage.local.get(ANON_ID_KEY);
  const existing = stored[ANON_ID_KEY] as string | undefined;
  if (existing) return existing;
  const created = crypto.randomUUID();
  await chrome.storage.local.set({ [ANON_ID_KEY]: created });
  return created;
}

const queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setInterval> | undefined;

/**
 * Record one event, if the user has not switched this off.
 *
 * Never throws and never blocks the caller: telemetry that can break a run is
 * worse than no telemetry.
 */
export function track(name: TelemetryEvent, meta?: TelemetryMeta): void {
  void (async () => {
    try {
      if (!(await loadTelemetryEnabled())) return;
      queue.push({ name, ts: Date.now(), meta });
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
      if (queue.length >= FLUSH_AFTER) await flush();
      else startTimer();
    } catch {
      // Deliberately silent.
    }
  })();
}

function startTimer(): void {
  if (timer !== undefined) return;
  timer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
}

/** Send what is queued. Safe to call at any time, including with nothing queued. */
export async function flush(): Promise<void> {
  if (queue.length === 0) return;
  if (!(await loadTelemetryEnabled())) {
    queue.length = 0;
    return;
  }

  const events = queue.splice(0, queue.length);
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }

  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      // `no-cors` keeps this out of the install prompt; see the note at the
      // top. text/plain is a CORS-safelisted content type, so this is a simple
      // request with no preflight -- the collector parses the body as JSON
      // regardless of what the header says.
      mode: 'no-cors',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({
        app: APP,
        anonId: await anonId(),
        appVersion: chrome.runtime.getManifest().version,
        events,
      }),
    });
  } catch {
    // Dropped. A count is not worth a retry queue, and a retry queue is another
    // thing holding data about the user.
  }
}
