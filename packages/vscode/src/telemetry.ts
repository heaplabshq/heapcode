import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@heapcode/core';

// Shared collector — one Worker/DB for every heaplabs app, partitioned by
// `app`. Lives in its own repo since other apps depend on it too:
// https://github.com/heaplabshq/heaplabs-telemetry
const ENDPOINT = 'https://heaplabs-telemetry.y5ghjsdc4n.workers.dev/v1/events';
const APP = 'heapcode-vscode';
const ANON_ID_KEY = 'heapcode.telemetry.anonId';
const FLUSH_INTERVAL_MS = 30_000;
const MAX_QUEUE = 50;
const AUDIT_KEY = 'heapcode.audit.log';
const MAX_AUDIT_EVENTS = 500;

/**
 * Anonymous usage telemetry — event names and coarse metadata only, never
 * code/prompts/file contents/paths. Remote sending honors the global VS Code
 * `telemetry.telemetryLevel` setting and the extension's own
 * `heapcode.telemetry.enabled` (see README "Telemetry" section for both).
 *
 * Every tracked event is *also* kept in a local, capped audit log (PLAN.md
 * M13) — deliberately independent of the remote opt-out above, since it
 * never leaves the machine either way: this is what backs the local
 * usage/audit dashboard, not a second telemetry channel. Disabling remote
 * sending shouldn't blind you to your own local audit trail.
 */
export class Telemetry {
  private queue: AuditEvent[] = [];
  private readonly anonId: string;
  private readonly timer: ReturnType<typeof setInterval>;
  private auditLog: AuditEvent[];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    const existing = context.globalState.get<string>(ANON_ID_KEY);
    this.anonId = existing ?? randomUUID();
    if (!existing) void context.globalState.update(ANON_ID_KEY, this.anonId);
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.auditLog = context.globalState.get<AuditEvent[]>(AUDIT_KEY, []);
  }

  private get enabled(): boolean {
    if (!vscode.env.isTelemetryEnabled) return false;
    return vscode.workspace.getConfiguration('heapcode.telemetry').get<boolean>('enabled', true);
  }

  track(name: string, meta?: Record<string, unknown>): void {
    const ts = Date.now();
    this.auditLog.push({ name, ts, meta });
    if (this.auditLog.length > MAX_AUDIT_EVENTS) {
      this.auditLog.splice(0, this.auditLog.length - MAX_AUDIT_EVENTS);
    }
    void this.context.globalState.update(AUDIT_KEY, this.auditLog);

    if (!this.enabled) return;
    this.queue.push({ name, ts, meta });
    if (this.queue.length >= MAX_QUEUE) void this.flush();
  }

  /** The local audit trail — every tracked event regardless of the remote opt-out. Never leaves the machine. */
  auditHistory(): AuditEvent[] {
    return [...this.auditLog];
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
