import { wrapUntrusted } from '../agent/tools.js';

export interface ContextBlock {
  /** Shown to the model as a section header, e.g. "Selection (src/auth.ts)". */
  label: string;
  content: string;
  /** Lower = more important. Blocks are included in priority order. */
  priority: number;
  /**
   * 'untrusted' (the default posture for anything read from a file, folder,
   * terminal, or semantic search rather than typed directly by the user)
   * gets wrapped with a data-not-instructions notice — see tools.ts
   * UNTRUSTED_NOTICE / PLAN.md M7.
   */
  trust?: 'trusted' | 'untrusted';
}

export interface AssembledContext {
  text: string;
  included: string[];
  dropped: string[];
}

/**
 * Assembles context blocks under a character budget (≈ tokens × 4).
 * Deterministic: includes by priority, truncates at most the last block,
 * and reports what was dropped so callers can log it.
 */
export function assembleContext(blocks: ContextBlock[], budgetChars = 24_000): AssembledContext {
  const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
  const parts: string[] = [];
  const included: string[] = [];
  const dropped: string[] = [];
  let used = 0;

  for (const block of sorted) {
    if (!block.content.trim()) continue;
    const untrusted = block.trust === 'untrusted';
    const header = `\n\n--- ${block.label}${untrusted ? ' [untrusted data]' : ''} ---\n`;
    const remaining = budgetChars - used - header.length;
    if (remaining <= 200) {
      dropped.push(block.label);
      continue;
    }
    let content = untrusted ? wrapUntrusted(block.content) : block.content;
    if (content.length > remaining) {
      content = content.slice(0, remaining) + '\n…[truncated]';
    }
    parts.push(header + content);
    included.push(block.label);
    used += header.length + content.length;
  }

  return { text: parts.join(''), included, dropped };
}
