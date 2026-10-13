import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Flow } from './flow.js';
import type { SavedFingerprints } from './record.js';
import { serializeFlow } from './serialize.js';
import { parseEnvFile } from './template.js';
import { DEFAULT_SECRETS_FILE, FLOWS_DIR } from './workspace.js';

/** Writing what the recorder (and later the AI writer and healer) produce into the opened folder. */

export function flowPath(dir: string, id: string): string {
  return join(dir, FLOWS_DIR, `${id}.yaml`);
}

/** Beside the flow, not in it: the YAML stays readable, healing still has what it needs. */
export function fingerprintsPath(dir: string, id: string): string {
  return join(dir, FLOWS_DIR, `${id}.fingerprints.json`);
}

export function writeFlow(dir: string, id: string, flow: Flow, fingerprints?: SavedFingerprints): string {
  const path = flowPath(dir, id);
  writeFileSync(path, serializeFlow(flow));
  if (fingerprints && fingerprints.steps.length) writeFileSync(fingerprintsPath(dir, id), `${JSON.stringify(fingerprints, null, 2)}\n`);
  return path;
}

export function readFingerprints(dir: string, id: string): SavedFingerprints | undefined {
  const path = fingerprintsPath(dir, id);
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
