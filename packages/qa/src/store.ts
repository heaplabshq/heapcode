import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Flow } from './flow.js';
import type { SavedFingerprints } from './record.js';
import { serializeFlow } from './serialize.js';
import { parseEnvFile } from './template.js';
import { DEFAULT_SECRETS_FILE, FLOWS_DIR, STEPS_DIR } from './workspace.js';

/** Writing what the recorder (and later the AI writer and healer) produce into the opened folder. */

export function flowPath(dir: string, id: string): string {
  return join(dir, FLOWS_DIR, `${id}.yaml`);
}

/** Beside the flow, not in it: the YAML stays readable, healing still has what it needs. */
export function fingerprintsPath(dir: string, id: string): string {
  return join(dir, FLOWS_DIR, `${id}.fingerprints.json`);
}

/** `flows` for a test, `steps` for a reusable step — the same files either way. */
export type FlowKind = 'flow' | 'step';

function folder(kind: FlowKind): string {
  return kind === 'flow' ? FLOWS_DIR : STEPS_DIR;
}

export function stepPath(dir: string, id: string): string {
  return join(dir, STEPS_DIR, `${id}.yaml`);
}

export function writeFlow(dir: string, id: string, flow: Flow, fingerprints?: SavedFingerprints, kind: FlowKind = 'flow'): string {
  mkdirSync(join(dir, folder(kind)), { recursive: true });
  const path = join(dir, folder(kind), `${id}.yaml`);
  writeFileSync(path, serializeFlow(flow));
  const fpPath = join(dir, folder(kind), `${id}.fingerprints.json`);
  if (fingerprints && fingerprints.steps.length) writeFileSync(fpPath, `${JSON.stringify(fingerprints, null, 2)}\n`);
  // A flow that lost all its element steps to a `use:` has nothing left to heal.
  else if (fingerprints && existsSync(fpPath)) rmSync(fpPath);
  return path;
}

export function readFingerprints(dir: string, id: string, kind: FlowKind = 'flow'): SavedFingerprints | undefined {
  const path = join(dir, folder(kind), `${id}.fingerprints.json`);
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as SavedFingerprints;
    return data.version === 1 && Array.isArray(data.steps) ? data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Add secrets to the folder's secrets file, never replacing one already there.
 * Returns the names actually written.
 */
export function saveSecrets(dir: string, secrets: Record<string, string>, file = DEFAULT_SECRETS_FILE): string[] {
  const path = join(dir, file);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const existing = parseEnvFile(before);
  const added = Object.entries(secrets).filter(([name]) => !(name in existing));
  if (added.length === 0) return [];
  const lines = added.map(([name, value]) => `${name}=${quote(value)}`);
  writeFileSync(path, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
  return added.map(([name]) => name);
}

/** As `parseEnvFile` reads it back: plain, or wrapped in whichever quote the value does not contain. */
function quote(value: string): string {
  if (!/[\s#"'$]/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return value;
}
