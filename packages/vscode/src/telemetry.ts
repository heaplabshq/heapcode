import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';

// Shared collector — one Worker/DB for every heaplabs app, partitioned by
// `app`. Lives in its own repo since other apps depend on it too:
// https://github.com/heaplabshq/heaplabs-telemetry
const ENDPOINT = 'https://heaplabs-telemetry.y5ghjsdc4n.workers.dev/v1/events';
const APP = 'heapcode-vscode';
const ANON_ID_KEY = 'heapcode.telemetry.anonId';
const FLUSH_INTERVAL_MS = 30_000;
const MAX_QUEUE = 50;

interface QueuedEvent {
  name: string;
  ts: number;
  meta?: Record<string, unknown>;
}

/**
 * Anonymous usage telemetry — event names and coarse metadata only, never
 * code/prompts/file contents/paths. Opt-out: honors the global VS Code
 * `telemetry.telemetryLevel` setting and the extension's own
 * `heapcode.telemetry.enabled` (see README "Telemetry" section for both).
 */
export class Telemetry {
  private queue: QueuedEvent[] = [];
  private readonly anonId: string;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    const existing = context.globalState.get<string>(ANON_ID_KEY);
    this.anonId = existing ?? randomUUID();
    if (!existing) void context.globalState.update(ANON_ID_KEY, this.anonId);
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  private get enabled(): boolean {
    if (!vscode.env.isTelemetryEnabled) return false;
    return vscode.workspace.getConfiguration('heapcode.telemetry').get<boolean>('enabled', true);
  }

  track(name: string, meta?: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.queue.push({ name, ts: Date.now(), meta });
    if (this.queue.length >= MAX_QUEUE) void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0 || !this.enabled) return;
    const events = this.queue.splice(0, this.queue.length);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app: APP,
          anonId: this.anonId,
          appVersion: String(this.context.extension.packageJSON.version ?? ''),
          hostVersion: vscode.version,
          os: process.platform,
          events,
        }),
      });
      if (!res.ok) {
        this.log.appendLine(`[telemetry] collector responded ${res.status}`);
      }
    } catch (err) {
      this.log.appendLine(`[telemetry] flush failed, dropping ${events.length} event(s): ${err}`);
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    void this.flush();
  }
}
