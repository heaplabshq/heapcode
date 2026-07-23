import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEvent } from '@heapcode/core';

const MAX_AUDIT_EVENTS = 500;

/**
 * Local-only, capped audit trail — the CLI's equivalent of the extension's
 * Telemetry class, but deliberately ported without its remote-flush half
 * (packages/vscode/src/telemetry.ts posts to a heaplabs collector endpoint).
 * A CI-run headless agent must make no network call beyond the configured
 * model endpoint (CLI-M4 exit criteria) — bundling in a remote-telemetry
 * decision here would risk that by default. What's ported is exactly the
 * part the plan calls "local capped audit log": event name + coarse
 * metadata only, never code/prompts/paths, never leaves the machine.
 * Stored at ~/.heapcode/audit.json (global, like config — audit history
 * spanning every project you've used heapcode in is the useful view, same
 * scope as the extension's own context.globalState-backed log).
 */
export class AuditLog {
  private events: AuditEvent[] = [];
  private loaded = false;

  constructor(
    private readonly path: string,
    private readonly enabled: () => boolean = () => true,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.events = JSON.parse(await readFile(this.path, 'utf8')) as AuditEvent[];
    } catch {
      this.events = [];
    }
  }

  async track(name: string, meta?: Record<string, unknown>): Promise<void> {
    if (!this.enabled()) return;
    await this.load();
    this.events.push({ name, ts: Date.now(), meta });
    if (this.events.length > MAX_AUDIT_EVENTS) this.events.splice(0, this.events.length - MAX_AUDIT_EVENTS);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.events), 'utf8');
  }

  async history(): Promise<AuditEvent[]> {
    await this.load();
    return [...this.events];
  }
}
