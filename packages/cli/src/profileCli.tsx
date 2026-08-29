import React from 'react';
import { render } from 'ink';
import type { ProviderProfileConfig } from '@heapcode/core';
import { ConfigStore, SecretsStore } from '@heapcode/host';
import { Setup } from './ink/Setup.js';

/**
 * `heapcode profile add` and the automatic first-run flow (no profile
 * configured yet) both mount this same Ink onboarding component — arrow-key
 * provider/model selection, inline text inputs — instead of a separate
 * plain-readline wizard, so setup feels like the same product as the rest
 * of the terminal UI (and matches Claude Code's own onboarding shape).
 * Resolves with the saved, now-active profile once the user completes it.
 */
export function profileAdd(): Promise<ProviderProfileConfig> {
  return new Promise((resolve) => {
    let completed = false;
    const instance = render(
      <Setup
        onComplete={(profile) => {
          completed = true;
          instance.unmount();
          resolve(profile);
        }}
      />,
    );
    // Ctrl+C during onboarding exits the Ink app (default exitOnCtrlC) but
    // would leave this promise pending forever — the process would hang with
    // no UI. Treat an incomplete exit as the user bailing out.
    void instance.waitUntilExit().then(() => {
      if (!completed) process.exit(130);
    });
  });
}

export async function profileList(): Promise<void> {
  const config = new ConfigStore();
  const cfg = await config.load();
  if (cfg.profiles.length === 0) {
    console.log('No profiles configured yet. Run "heapcode profile add".');
    return;
  }
  for (const p of cfg.profiles) {
    const active = p.name === cfg.activeProfile ? '*' : ' ';
    console.log(`${active} ${p.name}  (${p.preset}, ${p.model})`);
    // Roles only when set — a profile that inherits everything should print
    // as one line, not as a wall of blanks.
    for (const field of PROFILE_FIELDS) {
      const value = p[field];
      if (value !== undefined && value !== '') console.log(`    ${field}: ${String(value)}`);
    }
  }
}

/**
 * Profile fields `heapcode profile set` can write.
 *
 * The onboarding flow covers the four a profile cannot work without; these are
 * the rest — mostly the per-role model overrides, which had no CLI surface at
 * all. `applyModel` in particular is `edit_file`'s fallback when a
 * search/replace does not match, and it is worth the most on exactly the small
 * local models a terminal user is likeliest to be running.
 */
export const PROFILE_FIELDS = [
  'model',
  'baseUrl',
  'agentModel',
  'applyModel',
  'editModel',
  'completionModel',
  'embeddingsModel',
  'rerankModel',
  'contextModel',
  'agentProfile',
  'applyProfile',
  'editProfile',
  'completionProfile',
  'embeddingsProfile',
  'rerankProfile',
  'contextProfile',
  'promptProfile',
] as const satisfies ReadonlyArray<keyof ProviderProfileConfig>;

/**
 * Fields that take one of a fixed set of values rather than free text.
 *
 * Every other field here is a model id or a profile name, which this command
 * cannot check — a typo surfaces at the provider. These it can, and should:
 * `promptProfile` silently ignoring "leen" would leave the user believing
 * they had changed how the agent is prompted.
 */
const ENUM_FIELDS: Partial<Record<ProfileField, readonly string[]>> = {
  promptProfile: ['full', 'lean'],
};

export type ProfileField = (typeof PROFILE_FIELDS)[number];

export function isProfileField(name: string): name is ProfileField {
  return (PROFILE_FIELDS as readonly string[]).includes(name);
}

/**
 * `heapcode profile set <name> <field> [value]`.
 *
 * An omitted value clears the field, which is the difference between "this
 * role runs on some model I chose" and "this role inherits" — storing an empty
 * string instead would point the role at a model with no name and fail much
 * later, at the provider.
 */
export async function profileSet(name: string, field: ProfileField, value?: string): Promise<void> {
  const config = new ConfigStore();
  const profile = await config.getProfile(name);
  if (!profile) {
    console.error(`No profile named "${name}". Run "heapcode profile list" to see them.`);
    process.exitCode = 1;
    return;
  }
  const allowed = ENUM_FIELDS[field];
  if (value && allowed && !allowed.includes(value)) {
    console.error(`"${value}" is not a valid ${field}. Use one of: ${allowed.join(', ')}.`);
    process.exitCode = 1;
    return;
  }
  const next: ProviderProfileConfig = { ...profile };
  if (value === undefined || value === '') delete next[field];
  else Object.assign(next, { [field]: value });
  await config.saveProfile(next);
  console.log(value ? `${name}.${field} = ${value}` : `${name}.${field} cleared (inherits again)`);
}

export async function profileUse(name: string): Promise<void> {
  const config = new ConfigStore();
  await config.setActiveProfile(name);
  console.log(`Active profile: ${name}`);
}

export async function profileRemove(name: string): Promise<void> {
  const config = new ConfigStore();
  const secrets = new SecretsStore();
  await config.deleteProfile(name);
  await secrets.deleteApiKey(name);
  console.log(`Removed profile "${name}".`);
}
