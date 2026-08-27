import { getPreset, providerPresets, type PresetId } from '@heapcode/core/providers';
import type { ProviderProfileConfig } from '@heapcode/core/providers';

/**
 * Where heapbrowse's configuration lives, and why it lives there.
 *
 * `chrome.storage.local`, never `chrome.storage.sync`. The API key is the
 * reason: sync replicates to every machine signed into the same Chrome profile
 * and through Google's servers on the way, which is not somewhere a user's
 * provider key should end up because they happened to install an extension
 * (PRD §7.2). The key is BYOK and stays on the device that typed it.
 *
 * The profile shape is core's `ProviderProfileConfig` rather than a local
 * invention, so a profile means the same thing here as it does in the CLI and
 * the extension. Only the chat-relevant fields are surfaced in M0's UI; the
 * rest of the shape is carried untouched.
 */

const PROFILE_KEY = 'heapbrowse.profile';
const API_KEY = 'heapbrowse.apiKey';
const DEBUGGER_KEY = 'heapbrowse.useDebugger';
const FILES_KEY = 'heapbrowse.files';

/** The profile with no key attached — safe to log, safe to render. */
export type StoredProfile = ProviderProfileConfig;

export function defaultProfile(): StoredProfile {
  const preset = getPreset('ollama');
  return {
    name: 'default',
    preset: 'ollama',
    baseUrl: preset.defaultBaseUrl,
    model: '',
  };
}

export async function loadProfile(): Promise<StoredProfile> {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  const profile = stored[PROFILE_KEY] as StoredProfile | undefined;
  return profile ?? defaultProfile();
}

export async function saveProfile(profile: StoredProfile): Promise<void> {
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
}

/**
 * The API key is read on demand and never held in React state alongside the
 * profile — keeping the two apart is what makes it possible to render or log a
 * profile without a redaction step that someone will eventually forget.
 */
export async function loadApiKey(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(API_KEY);
  const key = stored[API_KEY] as string | undefined;
  return key && key.length > 0 ? key : undefined;
}

export async function saveApiKey(key: string): Promise<void> {
  if (key.length === 0) await chrome.storage.local.remove(API_KEY);
  else await chrome.storage.local.set({ [API_KEY]: key });
}

/** Presets offered in the UI, in the order they are shown. */
export const presets = providerPresets;

export function presetById(id: PresetId) {
  return getPreset(id);
}

/**
 * A key is only *required* by some presets. Reporting this separately from
 * "is a key present" lets setup tell a local-Ollama user they are done rather
 * than nagging them for a credential the endpoint will ignore.
 */
export function needsApiKey(profile: StoredProfile): boolean {
  return getPreset(profile.preset).requiresApiKey;
}


/**
 * Whether to drive pages through the Chrome DevTools Protocol.
 *
 * On by default, because it is strictly more capable and every per-site failure
 * this product has had came from the alternative estimating what CDP simply
 * knows. Defaulting it off meant the good path was the one nobody was on.
 *
 * "On" is only ever a preference: the `debugger` permission is optional and
 * cannot be granted without a user gesture, so a fresh install is on-but-not-
 * granted and quietly runs the content-script path until someone allows it.
 * That is why the setting and the grant are reported separately in the UI --
 * a switch that says on while nothing changed is worse than one that says off.
 */
export async function loadUseDebugger(): Promise<boolean> {
  const stored = await chrome.storage.local.get(DEBUGGER_KEY);
  return stored[DEBUGGER_KEY] !== false;
}

export async function saveUseDebugger(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [DEBUGGER_KEY]: value });
}

/**
 * Absolute paths the agent may attach to a form.
 *
 * Configured by the user rather than chosen by the model, and the model only
 * ever names one of them. `DOM.setFileInputFiles` takes a real path on the
 * machine, so a model free to invent paths would be a model able to upload any
 * file it can guess the location of -- prompted, potentially, by the page it is
 * reading.
 */
export async function loadFiles(): Promise<string[]> {
  const stored = await chrome.storage.local.get(FILES_KEY);
  const files = stored[FILES_KEY];
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [];
}

export async function saveFiles(paths: string[]): Promise<void> {
  await chrome.storage.local.set({ [FILES_KEY]: paths.filter((p) => p.trim().length > 0) });
}
