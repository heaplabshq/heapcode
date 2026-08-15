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
  }
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
