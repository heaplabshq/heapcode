import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { Flow, QaConfig, Step } from './flow.js';
import { parseConfig, parseFlow, type ParseError } from './parse.js';
import { parseEnvFile } from './template.js';

/**
 * The folder opened in Heap QA, read from disk.
 *
 * ```
 * <folder>/
 *   heapqa.yaml     settings (optional)
 *   flows/*.yaml    the tests
 *   steps/*.yaml    reusable steps, used as `use: <file name>`
 *   results/        one folder per run (written by the runner)
 * ```
 *
 * Every file is parsed and every problem collected — a broken step file is
 * reported alongside a broken flow, not discovered halfway through a run.
 */
export interface Workspace {
  dir: string;
  config: QaConfig;
  /** By file name without extension — what `heapcode qa run <name>` takes. */
  flows: Map<string, Flow>;
  /** By file name without extension — what `use:` takes. */
  steps: Map<string, Flow>;
  /** `{{secret:NAME}}` lookup: the environment first, then the secrets file. */
  secret: (name: string) => string | undefined;
  /** Names defined in the secrets file — what an AI run may type as placeholders. Never values. */
  secretNames: string[];
  errors: ParseError[];
}

export const CONFIG_FILE = 'heapqa.yaml';
export const FLOWS_DIR = 'flows';
export const STEPS_DIR = 'steps';
export const RESULTS_DIR = 'results';
/** Saved pictures for screenshot checks — committed with the flows. */
export const SNAPSHOTS_DIR = 'snapshots';
/** AI-written flows that did not replay — kept for a person to look at, never run. */
export const DRAFTS_DIR = 'drafts';
/** Read for secrets when heapqa.yaml names no `secretsFile`. */
export const DEFAULT_SECRETS_FILE = '.env.test';

export function loadWorkspace(dir: string, env: Record<string, string | undefined> = process.env): Workspace {
  const errors: ParseError[] = [];
  const configPath = join(dir, CONFIG_FILE);
  const configText = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const parsedConfig = parseConfig(configText, CONFIG_FILE);
  let config: QaConfig = { targets: [], browser: {}, timeout: 10_000, heal: 'ai' };
  if (parsedConfig.ok) config = parsedConfig.value;
  else errors.push(...parsedConfig.errors);

  const flows = readFlows(dir, FLOWS_DIR, errors);
  const steps = readFlows(dir, STEPS_DIR, errors);
  errors.push(...checkUses(flows, steps));

  const secretsPath = join(dir, config.secretsFile ?? DEFAULT_SECRETS_FILE);
  let fileSecrets: Record<string, string> = {};
  if (existsSync(secretsPath)) fileSecrets = parseEnvFile(readFileSync(secretsPath, 'utf8'));
  else if (config.secretsFile) errors.push({ message: `secretsFile ${config.secretsFile} does not exist.`, file: CONFIG_FILE });

  return {
    dir,
    config,
    flows,
    steps,
    secret: (name) => env[name] ?? fileSecrets[name],
    secretNames: Object.keys(fileSecrets),
    errors,
  };
}

function readFlows(dir: string, sub: string, errors: ParseError[]): Map<string, Flow> {
  const out = new Map<string, Flow>();
  const folder = join(dir, sub);
  if (!existsSync(folder)) return out;
  for (const entry of readdirSync(folder).sort()) {
    const ext = extname(entry);
    if (ext !== '.yaml' && ext !== '.yml') continue;
    const path = join(folder, entry);
    const file = relative(dir, path);
    const result = parseFlow(readFileSync(path, 'utf8'), file);
    if (result.ok) out.set(basename(entry, ext), result.value);
    else errors.push(...result.errors);
  }
  return out;
}

/** Every `use:` names a step that exists, and no step uses itself, however indirectly. */
function checkUses(flows: Map<string, Flow>, steps: Map<string, Flow>): ParseError[] {
  const errors: ParseError[] = [];
  const usesOf = (flow: Flow): Step[] => flow.steps.filter((s) => s.kind === 'use');

  for (const flow of [...flows.values(), ...steps.values()]) {
    for (const step of usesOf(flow)) {
      if (step.kind === 'use' && !steps.has(step.use)) {
        const known = [...steps.keys()];
        errors.push({
          message: `No reusable step \`${step.use}\` — expected steps/${step.use}.yaml.${known.length ? ` Known: ${known.join(', ')}.` : ''}`,
          file: step.file,
          line: step.line,
        });
      }
    }
  }

  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (name: string, chain: string[]): void => {
    if (done.has(name)) return;
    if (visiting.has(name)) {
      const flow = steps.get(name)!;
      errors.push({ message: `Reusable steps use each other in a loop: ${[...chain, name].join(' → ')}.`, file: flow.file, line: flow.line });
      return;
    }
    visiting.add(name);
    for (const step of usesOf(steps.get(name)!)) if (step.kind === 'use' && steps.has(step.use)) visit(step.use, [...chain, name]);
    visiting.delete(name);
    done.add(name);
  };
  for (const name of steps.keys()) visit(name, []);
  return errors;
}

/** Which flows a run means: every one, or the named ones (by file name or path). */
export function selectFlows(workspace: Workspace, names: string[]): { flows: [string, Flow][]; unknown: string[] } {
  if (names.length === 0) return { flows: [...workspace.flows], unknown: [] };
  const flows: [string, Flow][] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const key = basename(raw, extname(raw));
    const flow = workspace.flows.get(key);
    if (flow) flows.push([key, flow]);
    else unknown.push(raw);
  }
  return { flows, unknown };
}
