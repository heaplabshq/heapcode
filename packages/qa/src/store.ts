import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Flow } from './flow.js';
import { stepTarget, withTarget, type SavedFingerprints } from './record.js';
import { parseFlow } from './parse.js';
import type { FingerprintRefresh, HealProposal, StepSource } from './run.js';
import { serializeFlow } from './serialize.js';
import { parseEnvFile } from './template.js';
import { DEFAULT_SECRETS_FILE, DRAFTS_DIR, FLOWS_DIR, STEPS_DIR } from './workspace.js';

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

/** Where an AI-written flow goes when it did not replay: not in flows/, so `run` never picks it up. */
export function writeDraft(dir: string, id: string, flow: Flow): string {
  mkdirSync(join(dir, DRAFTS_DIR), { recursive: true });
  const path = join(dir, DRAFTS_DIR, `${id}.yaml`);
  writeFileSync(path, serializeFlow(flow));
  return path;
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

function sourcePath(dir: string, source: StepSource): string {
  return join(dir, source.kind === 'flow' ? FLOWS_DIR : STEPS_DIR, `${source.id}.yaml`);
}

function sourceKey(source: StepSource): string {
  return `${source.kind}:${source.id}`;
}

function group<T extends { source: StepSource }>(items: T[]): Map<string, { source: StepSource; items: T[] }> {
  const out = new Map<string, { source: StepSource; items: T[] }>();
  for (const item of items) {
    const key = sourceKey(item.source);
    if (!out.has(key)) out.set(key, { source: item.source, items: [] });
    out.get(key)!.items.push(item);
  }
  return out;
}

export interface AppliedHeal {
  proposal: HealProposal;
  applied: boolean;
  /** Why not, when not. */
  reason?: string;
  file: string;
  /** The file had comments, which rewriting it dropped. */
  commentsLost?: boolean;
}

/**
 * Write accepted heals into their flow and step files: the step's locator
 * becomes the healed one, its fingerprint the healed element's, and the heal
 * is added to the step's history. A proposal whose step no longer has the
 * locator it was made against (the file was edited since) is skipped, not
 * forced. The same step healed in several flows of one run is written once.
 */
export function applyHeals(dir: string, proposals: HealProposal[], at = new Date()): AppliedHeal[] {
  const results: AppliedHeal[] = [];
  for (const { source, items } of group(proposals).values()) {
    const path = sourcePath(dir, source);
    const shown = join(source.kind === 'flow' ? FLOWS_DIR : STEPS_DIR, `${source.id}.yaml`);
    if (!existsSync(path)) {
      for (const proposal of items) results.push({ proposal, applied: false, reason: 'the file is gone', file: shown });
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const hadComments = /^\s*#/m.test(text);
    const parsed = parseFlow(text, shown);
    if (!parsed.ok) {
      for (const proposal of items) results.push({ proposal, applied: false, reason: 'the file no longer parses', file: shown });
      continue;
    }
    let flow = parsed.value;
    const fingerprints: SavedFingerprints = readFingerprints(dir, source.id, source.kind) ?? { version: 1, steps: [] };
    const done = new Set<number>();
    for (const proposal of items) {
      const step = flow.steps[proposal.step - 1];
      const current = step && stepTarget(step);
      if (done.has(proposal.step)) {
        results.push({ proposal, applied: false, reason: 'already healed by another flow in this run', file: shown });
        continue;
      }
      if (!step || !current || JSON.stringify(current) !== JSON.stringify(proposal.previous)) {
        results.push({ proposal, applied: false, reason: 'the step was edited since the run', file: shown });
        continue;
      }
      done.add(proposal.step);
      flow = { ...flow, steps: flow.steps.map((s, i) => (i === proposal.step - 1 ? withTarget(s, proposal.locator) : s)) };
      const entry = fingerprints.steps.find((f) => f.step === proposal.step);
      const history = [...(entry?.heals ?? []), { at: at.toISOString(), via: proposal.via, from: proposal.previous, to: proposal.locator }];
      const next = { step: proposal.step, locator: proposal.locator, fingerprint: proposal.fingerprint ?? entry?.fingerprint, heals: history };
      fingerprints.steps = [...fingerprints.steps.filter((f) => f.step !== proposal.step), ...(next.fingerprint ? [next as SavedFingerprints['steps'][number]] : [])].sort((a, b) => a.step - b.step);
      results.push({ proposal, applied: true, file: shown, ...(hadComments ? { commentsLost: true } : {}) });
    }
    if (done.size) writeFlow(dir, source.id, flow, fingerprints, source.kind);
  }
  return results;
}

/** Save the fingerprints a passing run saw, keeping each step's heal history. */
export function saveRefreshed(dir: string, refreshed: FingerprintRefresh[]): void {
  for (const { source, items } of group(refreshed).values()) {
    if (!existsSync(sourcePath(dir, source))) continue;
    const fingerprints: SavedFingerprints = readFingerprints(dir, source.id, source.kind) ?? { version: 1, steps: [] };
    for (const r of items) {
      const old = fingerprints.steps.find((f) => f.step === r.step);
      const entry = { step: r.step, locator: r.locator, fingerprint: r.fingerprint, ...(old?.heals ? { heals: old.heals } : {}) };
      fingerprints.steps = [...fingerprints.steps.filter((f) => f.step !== r.step), entry].sort((a, b) => a.step - b.step);
    }
    const path = join(dir, source.kind === 'flow' ? FLOWS_DIR : STEPS_DIR, `${source.id}.fingerprints.json`);
    writeFileSync(path, `${JSON.stringify(fingerprints, null, 2)}\n`);
  }
}
