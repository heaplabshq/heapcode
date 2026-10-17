import type { ToolCall, ToolDefinition, ToolResult } from '@heapcode/core';
import type { Evidence } from './grounding.js';

/**
 * Another product's assistant, built on Heap Chat's session.
 *
 * Heapnotes' "Ask your notes" is a ChatSession — same models, history,
 * index, grounding and transcript — with a different job: its tools are the
 * notes commands, its prompt is about notes, and it may propose edits. A
 * persona supplies exactly those differences and nothing else, so the rest of
 * Heap Chat's behaviour (and its fixes) comes along for free.
 *
 * With a persona, Heap Chat's folder tools (`read_file`, `list_dir`,
 * `search`, `semantic_search`) are **not offered and refused by name**: they
 * read the folder directly, around whatever privacy rules the persona keeps.
 * Its own tools are the only way in; `semanticSearch` in the context is the
 * index, for the persona to filter before the model sees it.
 */
export interface ChatPersona {
  /** The product name, for refusals the model reads. */
  name: string;
  tools: ToolDefinition[];
  systemPrompt(): string;
  execute(call: ToolCall, ctx: PersonaContext, signal?: AbortSignal): Promise<ToolResult>;
  /** Run now, or ask the person first (shown with `preview`, never remembered). */
  permission(call: ToolCall): 'grant' | 'ask';
  /** What an asked-for call would change, for the approve card. Throwing means it can't be made: the model gets that reason and nothing runs. */
  preview?(call: ToolCall): Promise<ChatChangePreview | undefined>;
  /** Evidence rows for the grounding check, from one of its tools' results. */
  evidence?(name: string, args: Record<string, unknown> | undefined, content: string): Evidence[];
  /** Where its conversations are kept for a folder, apart from Heap Chat's own for it. */
  conversationsFile?(root: string | undefined): string;
}

export interface PersonaContext {
  /**
   * The folder's meaning search, straight from the index: blocks of
   * `--- path:from-to (score n) ---` then the passage, unfiltered — the
   * persona's to filter. Empty when the index has nothing (or no embeddings model).
   */
  semanticSearch(query: string, signal?: AbortSignal): Promise<ToolResult>;
}

/** A proposed change, as the approve card shows it. */
export interface ChatChangePreview {
  /** "Edit “Kyoto trip”", "New note “Ideas”". */
  title: string;
  before: string;
  after: string;
}
