import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FlowResult, StepResult } from './run.js';
import { renderExploreReport, renderHtmlReport, renderJunit, renderMarkdown, type ExploreReportInput } from './report.js';
import type { ExploreResult } from './explore.js';
import { serializeFlow } from './serialize.js';
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

export interface SavedStep extends Omit<StepResult, 'screenshot' | 'visual'> {
  /** Relative to the run folder. */
  screenshot?: string;
  /** As in StepResult, with `diff` a path relative to the run folder. */
  visual?: Omit<NonNullable<StepResult['visual']>, 'diff'> & { diff?: string };
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
    const { screenshot, visual, ...rest } = step;
    const folder = join(runDir, 'screenshots', flow.id);
    const saved: SavedStep = { ...rest };
    if (visual) {
      const { diff, ...keep } = visual;
      saved.visual = keep;
      if (diff?.length) {
        mkdirSync(folder, { recursive: true });
        const file = join(folder, `${step.path}-diff.png`);
        writeFileSync(file, diff);
        saved.visual.diff = relative(runDir, file);
      }
    }
    if (!screenshot || screenshot.length === 0) return saved;
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${step.path}.png`);
    writeFileSync(file, screenshot);
    return { ...saved, screenshot: relative(runDir, file) };
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

/**
 * An explore run, in `results/<run id>-explore/`: explore.json, report.html,
 * a screenshot and a repro flow per finding. Returns the report's path.
 */
export function writeExplore(workspaceDir: string, runId: string, result: ExploreResult, meta: { start: string; startedAt: string; durationMs: number }): { dir: string; report: string } {
  const dir = join(workspaceDir, RESULTS_DIR, `${runId}-explore`);
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  mkdirSync(join(dir, 'repros'), { recursive: true });
  const findings: ExploreReportInput['findings'] = result.findings.map((f) => {
    const { screenshot, repro, ...rest } = f;
    const out: ExploreReportInput['findings'][number] = { ...rest };
    if (screenshot?.length) {
      writeFileSync(join(dir, 'screenshots', `${f.id}.png`), screenshot);
      out.screenshot = join('screenshots', `${f.id}.png`);
    }
    if (repro) {
      writeFileSync(join(dir, 'repros', `${f.id}.yaml`), serializeFlow(repro));
      out.repro = join('repros', `${f.id}.yaml`);
    }
    return out;
  });
  const input: ExploreReportInput = { runId, ...meta, pages: result.pages, findings, skipped: result.skipped };
  writeFileSync(join(dir, 'explore.json'), `${JSON.stringify(input, null, 2)}\n`);
  const report = join(dir, 'report.html');
  writeFileSync(report, renderExploreReport(input));
  return { dir, report };
}
