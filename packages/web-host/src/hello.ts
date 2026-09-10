import type { ModelRoleTable, ProviderProfileConfig } from '@heapcode/core';

/**
 * The hello a host sends the daemon when it opens a session.
 *
 * Its own file rather than living in session.ts, because both hosts build one
 * and only one of them owns that file. docs/CHAT_MODE_PLAN.md's first
 * guardrail is that Heap Chat never edits `web-host/src/session.ts`, and it
 * is checkable — `git diff` on that path — only while the file holds nothing
 * that Heap Chat legitimately needs to change. Adding an optional field to a
 * shared contract is exactly such a change, so the contract moved out rather
 * than the guardrail being quietly reinterpreted.
 */
export interface DaemonHello {
  root: string;
  profiles: ProviderProfileConfig[];
  activeProfile: string;
  /**
   * Which model on which connection serves each role — one global table.
   *
   * Required: every path that builds a hello must carry it. `reconnect` once
   * did not, which made changing a role the one action that left the daemon
   * with no table.
   */
  roles: ModelRoleTable;
  keys: Record<string, string>;
  /**
   * Non-code file extensions this host can turn into text, if any (see
   * HelloParams.documentExtensions). Absent for Heap Code, which indexes
   * source files and needs no parser to do it.
   */
  documentExtensions?: string[];
}

