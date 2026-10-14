import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FlowResult, StepResult } from './run.js';
import { renderHtmlReport, renderJunit, renderMarkdown } from './report.js';
import { RESULTS_DIR } from './workspace.js';

/**
 * A run's results, inside the opened folder:
 *
 * ```
 * results/<run id>/
 *   run.json                    everything below, minus the images
 *   screenshots/<flow>/<step>.png
 *   traces/<flow>.zip           failed flows only — open with `npx playwright show-trace`
 *   pages/<flow>.json           failed flows only — the whole page at the failing step
 *   report.html, junit.xml, summary.md
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

export interface SavedFlow extends Omit<FlowResult, 'steps' | 'trace' | 'refreshed' | 'failurePage'> {
  steps: SavedStep[];
  trace?: string;
  /** Relative to the run folder: the whole page at the failure, as JSON. */
  failurePage?: string;
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
  // Refreshed fingerprints go to the flow's fingerprints file, not the report;
  // the failure page is big, so it gets a file of its own.
  const { trace, refreshed: _refreshed, failurePage, ...rest } = flow;
  let pageFile: string | undefined;
  if (failurePage) {
    mkdirSync(join(runDir, 'pages'), { recursive: true });
    pageFile = join(runDir, 'pages', `${flow.id}.json`);
    writeFileSync(pageFile, JSON.stringify(failurePage));
  }
  return { ...rest, steps, ...(trace ? { trace: relative(runDir, trace) } : {}), ...(pageFile ? { failurePage: relative(runDir, pageFile) } : {}) };
}

export function writeRunSummary(summary: RunSummary): string {
  const file = join(summary.dir, 'run.json');
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  return file;
}

/** report.html, junit.xml and summary.md beside run.json. Returns the HTML report's path. */
export function writeReports(summary: RunSummary): string {
  const html = join(summary.dir, 'report.html');
  writeFileSync(html, renderHtmlReport(summary));
  writeFileSync(join(summary.dir, 'junit.xml'), renderJunit(summary));
  writeFileSync(join(summary.dir, 'summary.md'), renderMarkdown(summary));
  return html;
}
