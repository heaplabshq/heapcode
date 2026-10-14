import type { ExploreReportInput, RunSummary, StepResult } from '@heapcode/qa';

/**
 * Heap QA's page ↔ host protocol, over the same JSON-RPC socket shell as Heap
 * Code and Heap Chat (`@heapcode/web-host`). Types only — imported by the page.
 */

export const QA_PROTOCOL_VERSION = 1;

export const QA_METHODS = {
  hello: 'qa/hello',
  state: 'qa/state',
  init: 'qa/init',
  setFolder: 'qa/setFolder',
  run: 'qa/run',
  explore: 'qa/explore',
  record: 'qa/record',
  recordStop: 'qa/recordStop',
  recordSave: 'qa/recordSave',
  recordDiscard: 'qa/recordDiscard',
  do: 'qa/do',
  stop: 'qa/stop',
  runDetail: 'qa/runDetail',
  acceptHeals: 'qa/acceptHeals',
  flowSource: 'qa/flowSource',
  /** Host → page: progress of whatever is running. */
  event: 'qa/event',
  /** Host → page: the state changed (flows, runs, busy). */
  stateChanged: 'qa/stateChanged',
  /** Host → page request: allow an AI action that reads like it commits something? */
  confirm: 'qa/confirm',
} as const;

export interface QaFlowInfo {
  id: string;
  name: string;
  file: string;
  steps: number;
  /** From the newest run that included it. */
  last?: { status: 'passed' | 'failed'; runId: string };
}

export type QaJobKind = 'run' | 'explore' | 'record' | 'do';

export interface QaState {
  /** The test folder, when there is one. */
  folder?: string;
  folderName: string;
  /** Where a test folder would be made, when there is none yet. */
  suggestedFolder: string;
  /** Problems in the folder's files, one line each. */
  errors: string[];
  baseUrl?: string;
  heal: 'ai' | 'similarity' | 'off';
  flows: QaFlowInfo[];
  /** Reusable steps, by name. */
  steps: string[];
  runs: RunListing[];
  busy?: { kind: QaJobKind; label: string; startedAt: number; runId?: string };
  /** The agent role, for healing, diagnosis and AI-written flows. */
  model?: string;
  profile?: string;
  /** Served beyond this machine — recording and AI runs open a browser on the host, not here. */
  lan: boolean;
}

export type QaEvent =
  | { type: 'flowStart'; runId: string; flowId: string; name: string }
  | { type: 'step'; runId: string; flowId: string; step: Omit<StepResult, 'screenshot'> }
  | { type: 'healStart'; runId: string; flowId: string; what: string; model: string }
  | { type: 'diagnosis'; runId: string; flowId: string; text: string }
  | { type: 'flowEnd'; runId: string; flowId: string; status: 'passed' | 'failed'; error?: string; durationMs: number }
  | { type: 'runEnd'; runId: string; passed: number; failed: number; healed: number }
  | { type: 'page'; runId: string; url: string; index: number }
  | { type: 'finding'; runId: string; severity: 'high' | 'medium' | 'low'; title: string }
  | { type: 'exploreEnd'; runId: string; findings: number; high: number; pages: number }
  | { type: 'recordStep'; label: string; count: number }
  | { type: 'recordHint'; text: string }
  /** The person pressed Done or closed the window: the page should ask for a name. */
  | { type: 'recordFinished'; steps: number; title: string }
  | { type: 'action'; line: string }
  | { type: 'doEnd'; summary: string; saved?: string; draft?: string; error?: string; notSaved?: string }
  | { type: 'error'; message: string };

export interface QaRecordStopResult {
  steps: number;
  suggestedName: string;
  /** Reusable steps the recording repeats, to offer. */
  known: { key: string; use: string; from: number; to: number; note?: string }[];
  /** Secret names typed — values stay on the host. */
  secrets: string[];
  secretsFile: string;
}

export interface QaRecordSaveParams {
  name: string;
  /** Keys from `known` the person accepted. */
  use: string[];
  saveSecrets: boolean;
}

export interface QaRecordSaveResult {
  id: string;
  file: string;
  replay: { status: 'passed' | 'failed'; error?: string };
  secretsAdded: string[];
}

export type QaRunDetail = { kind: 'run'; summary: RunSummary } | { kind: 'explore'; explore: ExploreReportInput };

export interface QaAcceptHealsResult {
  applied: { file: string; step: number; applied: boolean; reason?: string }[];
}

/** A past run, as a list shows it. */
export interface RunListing {
  id: string;
  kind: 'run' | 'explore';
  startedAt: string;
  durationMs: number;
  /** Runs: passed / failed / healed. Explores: findings by severity. */
  passed?: number;
  failed?: number;
  healed?: number;
  findings?: { high: number; medium: number; low: number };
  pages?: number;
}
