import React from 'react';
import { render } from 'ink';
import {
  describeRole,
  isModelRole,
  MODEL_ROLES,
  type ModelRole,
  type ProviderProfileConfig,
} from '@heapcode/core';
import { ConfigStore, SecretsStore } from '@heapcode/host';
import { Setup } from './ink/Setup.js';

/**
 * `heapcode connection add` and the automatic first-run flow (no connection
 * configured yet) both mount this same Ink onboarding component — arrow-key
 * provider/model selection, inline text inputs — instead of a separate
 * plain-readline wizard, so setup feels like the same product as the rest
 * of the terminal UI (and matches Claude Code's own onboarding shape).
 * Resolves with the saved connection, which chat now runs on, once the user
 * completes it.
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

/**
 * `heapcode connection list` — the endpoints, and which one chat is on.
 *
 * Roles are deliberately not printed here any more. They are no longer a
 * property of a connection: one global table says which model on which
 * connection serves each role, and `heapcode model list` prints it. Repeating
 * it under every endpoint is what made the old output impossible to read.
 */
export async function profileList(): Promise<void> {
  const config = new ConfigStore();
  const connections = await config.listConnections();
  if (connections.length === 0) {
    console.log('No connections configured yet. Run "heapcode connection add".');
    return;
  }
  const chat = (await config.getRoles()).chat;
  for (const c of connections) {
    const active = c.name === chat?.connection ? '*' : ' ';
    console.log(`${active} ${c.name}  (${c.preset}, ${c.baseUrl})`);
  }
  console.log('\n"heapcode model list" shows which model serves each role.');
}

/**
 * `heapcode model list` — the whole role table, resolved.
 *
 * The point of printing it resolved is that the old settings screen made the
 * reader trace a redirect and a fallback chain by hand to answer "what runs
 * rerank?". Each line states the outcome and says when it was inherited.
 */
export async function modelList(): Promise<void> {
  const config = new ConfigStore();
  const model = await config.modelConfig();
  if (model.connections.length === 0) {
    console.log('No connections configured yet. Run "heapcode connection add".');
    return;
  }
  for (const role of MODEL_ROLES) {
    console.log(`  ${role.padEnd(11)} ${describeRole(model, role)}`);
  }
}

/**
 * `heapcode model set <role> <connection> <model>`.
 *
 * Both halves at once, always. An assignment naming a connection but no model
 * is a state nothing can run on, and it was reachable before: `profile use`
 * moved the active profile while leaving a model id that the new endpoint did
 * not serve.
 */
export async function modelSet(role: ModelRole, connection: string, model: string): Promise<void> {
  const config = new ConfigStore();
  if (!(await config.getConnection(connection))) {
    console.error(`No connection named "${connection}". Run "heapcode connection list" to see them.`);
    process.exitCode = 1;
    return;
  }
  if (role === 'chat') await config.setChatModel(connection, model);
  else await config.setRole(role, { connection, model });
  console.log(`${role} → ${model} on ${connection}`);
}

/**
 * `heapcode model clear <role>` — back to inheriting.
 *
 * Clearing is the difference between "this role runs a model I chose" and
 * "this role follows chat". Storing an empty model instead would point the
 * role at a model with no name and fail much later, at the provider.
 */
export async function modelClear(role: ModelRole): Promise<void> {
  if (role === 'chat') {
    console.error('Chat is what the other roles inherit from, so it cannot be cleared. Set it to another model instead.');
    process.exitCode = 1;
    return;
  }
  const config = new ConfigStore();
  await config.setRole(role);
  console.log(`${role} cleared — ${describeRole(await config.modelConfig(), role)}`);
}

export function isRoleName(name: string): name is ModelRole {
  return isModelRole(name);
}

export const ROLE_NAMES = MODEL_ROLES;

/** `heapcode connection use <name>` — moves chat to an endpoint, without a model. */
export async function profileUse(name: string): Promise<void> {
  const config = new ConfigStore();
  await config.setActiveProfile(name);
  console.log(
    `Chat moved to "${name}". Pick a model for it: heapcode model set chat ${name} <model>` +
      '\n(A model id means nothing on an endpoint that does not serve it, so it is not carried across.)',
  );
}

/**
 * `heapcode connection remove <name>`.
 *
 * Takes its API key with it, and any role assignment pointing at it — a
 * settings screen listing a model on an endpoint that no longer exists reads
 * as a bug rather than as a fallback. Roles that lose their assignment go back
 * to inheriting, which is stated rather than left to be discovered.
 */
export async function profileRemove(name: string): Promise<void> {
  const config = new ConfigStore();
  const secrets = new SecretsStore();
  const before = await config.getRoles();
  const orphaned = (Object.keys(before) as ModelRole[]).filter((r) => before[r]?.connection === name);
  await config.deleteConnection(name);
  await secrets.deleteApiKey(name);
  console.log(`Removed connection "${name}".`);
  if (orphaned.length > 0) {
    const model = await config.modelConfig();
    for (const role of orphaned) console.log(`  ${role} → ${describeRole(model, role)}`);
  }
}
