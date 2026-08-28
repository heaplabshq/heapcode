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
const PROFILES_KEY = 'heapbrowse.profiles';
const ACTIVE_KEY = 'heapbrowse.activeProfile';
const API_KEY = 'heapbrowse.apiKey';
/** Per-profile keys. The bare `API_KEY` above is the pre-profiles single key. */
const apiKeyFor = (name: string) => `${API_KEY}.${name}`;
const DEBUGGER_KEY = 'heapbrowse.useDebugger';
const FILES_KEY = 'heapbrowse.files';
const ONBOARDED_KEY = 'heapbrowse.onboarded';

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

/**
 * Every configured profile, and which one is in use.
 *
 * One stored profile was fine until it wasn't: the whole point of being
 * local-first *and* bring-your-own-key is that people run a small model at home
 * and a large one in the cloud, and switching meant retyping an endpoint, a
 * model name and a key every time. The shape is core's, and the CLI already had
 * this concept -- this is the extension catching up rather than inventing
 * anything.
 *
 * Migration is silent and happens on first read: a single stored profile
 * becomes a list of one, keeping its name, and its key moves to that name's
 * slot. Nobody should have to reconfigure because the storage layout changed.
 */
export async function loadProfiles(): Promise<StoredProfile[]> {
  const stored = await chrome.storage.local.get([PROFILES_KEY, PROFILE_KEY]);
  const profiles = stored[PROFILES_KEY] as StoredProfile[] | undefined;
  if (Array.isArray(profiles) && profiles.length > 0) return profiles;

  const single = stored[PROFILE_KEY] as StoredProfile | undefined;
  const migrated = [single ?? defaultProfile()];
  await chrome.storage.local.set({ [PROFILES_KEY]: migrated });

  // The old single key belongs to the migrated profile, and only to it.
  const legacy = (await chrome.storage.local.get(API_KEY))[API_KEY] as string | undefined;
  if (legacy) await chrome.storage.local.set({ [apiKeyFor(migrated[0]!.name)]: legacy });

  return migrated;
}

export async function saveProfiles(profiles: StoredProfile[]): Promise<void> {
  await chrome.storage.local.set({ [PROFILES_KEY]: profiles });
}

export async function activeProfileName(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(ACTIVE_KEY);
  const name = stored[ACTIVE_KEY];
  return typeof name === 'string' ? name : undefined;
}

export async function setActiveProfile(name: string): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_KEY]: name });
}

/** The profile in use: the chosen one, or the first, or an empty default. */
export async function loadProfile(): Promise<StoredProfile> {
  const [profiles, active] = await Promise.all([loadProfiles(), activeProfileName()]);
  return profiles.find((profile) => profile.name === active) ?? profiles[0] ?? defaultProfile();
}

/**
 * Save the active profile, replacing the entry with the same name.
 *
 * Renaming is a rename, not a new profile: the entry at the active name is
 * updated in place and the active pointer follows it, so editing the name field
 * does not silently leave a duplicate behind.
 */
export async function saveProfile(profile: StoredProfile): Promise<void> {
  const [profiles, active] = await Promise.all([loadProfiles(), activeProfileName()]);
  const current = active ?? profiles[0]?.name;
  const index = profiles.findIndex((candidate) => candidate.name === current);

  const next = index >= 0 ? profiles.map((p, i) => (i === index ? profile : p)) : [...profiles, profile];
  await saveProfiles(next);
  await setActiveProfile(profile.name);
  // Kept in step so anything still reading the old single key sees the truth.
  await chrome.storage.local.set({ [PROFILE_KEY]: profile });
}

/** Add a profile and make it the active one. Names are made unique. */
export async function addProfile(base?: StoredProfile): Promise<StoredProfile[]> {
  const profiles = await loadProfiles();
  const seed = base ?? defaultProfile();

  let name = seed.name === 'default' ? 'new profile' : `${seed.name} copy`;
  let suffix = 2;
  while (profiles.some((profile) => profile.name === name)) name = `${seed.name} copy ${suffix++}`;

  const created = { ...seed, name };
  const next = [...profiles, created];
  await saveProfiles(next);
  await setActiveProfile(name);
  return next;
}

/**
 * Delete a profile, and its key with it.
 *
 * The last profile is never deleted -- there would be nothing to fall back to,
 * and an extension with no endpoint configured is indistinguishable from a
 * broken one.
 */
export async function deleteProfile(name: string): Promise<StoredProfile[]> {
  const profiles = await loadProfiles();
  if (profiles.length <= 1) return profiles;

  const next = profiles.filter((profile) => profile.name !== name);
  await saveProfiles(next);
  await chrome.storage.local.remove(apiKeyFor(name));
  if ((await activeProfileName()) === name) await setActiveProfile(next[0]!.name);
  return next;
}

/**
 * The API key is read on demand and never held in React state alongside the
 * profile — keeping the two apart is what makes it possible to render or log a
 * profile without a redaction step that someone will eventually forget.
 */
export async function loadApiKey(profileName?: string): Promise<string | undefined> {
  const name = profileName ?? (await loadProfile()).name;
  const stored = await chrome.storage.local.get([apiKeyFor(name), API_KEY]);
  // The per-profile key first, falling back to the pre-profiles single key so
  // an install that has not yet re-saved anything still authenticates.
  const key = (stored[apiKeyFor(name)] ?? stored[API_KEY]) as string | undefined;
  return key && key.length > 0 ? key : undefined;
}

export async function saveApiKey(key: string, profileName?: string): Promise<void> {
  const name = profileName ?? (await loadProfile()).name;
  if (key.length === 0) await chrome.storage.local.remove(apiKeyFor(name));
  else await chrome.storage.local.set({ [apiKeyFor(name)]: key });
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

/**
 * Whether the first-run explanation has been through.
 *
 * A flag rather than inferring it from "is a model configured": someone who
 * skipped setup has decided something, and asking them again on every open
 * would be the opposite of respecting it.
 */
export async function loadOnboarded(): Promise<boolean> {
  const stored = await chrome.storage.local.get(ONBOARDED_KEY);
  return stored[ONBOARDED_KEY] === true;
}

export async function saveOnboarded(value: boolean): Promise<void> {
  await chrome.storage.local.set({ [ONBOARDED_KEY]: value });
}

/**
 * Whether heapbrowse may save files.
 *
 * A Chrome permission rather than a stored preference, so the answer is
 * Chrome's and the user can revoke it from the extension's own settings page
 * without heapbrowse being involved. It was a required permission, which meant
 * every install prompt carried "Manage your downloads" for a tool most people
 * will never reach for.
 */
export async function canDownload(): Promise<boolean> {
  return chrome.permissions.contains({ permissions: ['downloads'] });
}

/** Must be called from a user gesture; Chrome refuses otherwise. */
export async function requestDownloads(): Promise<boolean> {
  return chrome.permissions.request({ permissions: ['downloads'] });
}

export async function dropDownloads(): Promise<boolean> {
  return chrome.permissions.remove({ permissions: ['downloads'] });
}
