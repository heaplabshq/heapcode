import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FlowResult, StepResult } from './run.js';
import { RESULTS_DIR } from './workspace.js';

/**
 * A run's results, inside the opened folder:
 *
 * ```
 * results/<run id>/
 *   run.json                    everything below, minus the images
 *   screenshots/<flow>/<step>.png
 *   traces/<flow>.zip           failed flows only — open with `npx playwright show-trace`
 * ```
 *
 * In the folder rather than hidden in ~/.heapcode, so a person finds them
 * where their tests are and CI can upload the directory as it is. The starter
 * folder's .gitignore keeps them out of commits.
 */

export interface SavedStep extends Omit<StepResult, 'screenshot'> {
  /** Relative to the run folder. */
  screenshot?: string;
}

export interface SavedFlow extends Omit<FlowResult, 'steps' | 'trace' | 'refreshed'> {
  steps: SavedStep[];
  trace?: string;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  durationMs: number;
  /** Absolute path of the run folder. */
  dir: string;
  baseUrl?: string;
  passed: number;
  failed: number;
  flows: SavedFlow[];
}

/** `2026-10-14_03-31-05`: sorts by time, reads as one, safe in any file system. */
export function newRunId(at = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
}

export function createRunDir(workspaceDir: string, runId: string): string {
  const dir = join(workspaceDir, RESULTS_DIR, runId);
  mkdirSync(join(dir, 'traces'), { recursive: true });
  return dir;
}

export function tracePathFor(runDir: string, flowId: string): string {
  return join(runDir, 'traces', `${flowId}.zip`);
}

/** Write a flow's screenshots and return it with file references instead of bytes. */
export function saveFlow(runDir: string, flow: FlowResult): SavedFlow {
  const steps = flow.steps.map((step): SavedStep => {
    const { screenshot, ...rest } = step;
    if (!screenshot || screenshot.length === 0) return rest;
    const folder = join(runDir, 'screenshots', flow.id);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${step.path}.png`);
    writeFileSync(file, screenshot);
    return { ...rest, screenshot: relative(runDir, file) };
  });
  // Refreshed fingerprints go to the flow's fingerprints file, not the report.
  const { trace, refreshed: _refreshed, ...rest } = flow;
  return { ...rest, steps, ...(trace ? { trace: relative(runDir, trace) } : {}) };
}

export function writeRunSummary(summary: RunSummary): string {
  const file = join(summary.dir, 'run.json');
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  return file;
}
