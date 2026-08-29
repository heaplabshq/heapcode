/**
 * One place that assembles the user turn an agent run receives.
 *
 * Every host used to build this by hand — the extension, the Ink UI, headless,
 * the web host, and the sub-agent runner — and each hand-rolled copy drifted
 * only in which parts it forgot. The shape is the point: constraints the model
 * must obey BEFORE the task, separated by `---` so the task itself is never
 * confused with the rules that scope it.
 *
 * Kept in core rather than host because the sub-agent runner (also core)
 * builds the same shape, and because a change to the delimiter or the
 * `Task:` label is a prompt change that should reach every surface at once.
 */
export interface AgentTaskParts {
  /** Sub-agent scope notice; prepended before everything else when present. */
  scopeAddendum?: string;
  /** Persona constraints for this run (personas.ts). */
  personaAddendum?: string;
  /** Project instructions and memory (HEAPCODE.md / memory.md). */
  instructions?: string;
  /** Workspace context for @workspace mentions (semantic search or repo map). */
  workspaceContext?: string;
  /** Note about @ file/folder references in the task. */
  mentionNote?: string;
  /** The user's request. */
  task: string;
}

export function buildAgentTask(parts: AgentTaskParts): string {
  const preamble = [
    parts.scopeAddendum,
    parts.personaAddendum,
    parts.instructions,
    parts.workspaceContext,
    parts.mentionNote,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
  return preamble ? `${preamble}\n\n---\n\nTask: ${parts.task}` : parts.task;
}