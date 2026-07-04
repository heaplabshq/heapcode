export type PermissionClass = 'read' | 'write' | 'execute' | 'destructive';

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema for the arguments object. */
  parameters: Record<string, unknown>;
  permission: PermissionClass;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  content: string;
  isError?: boolean;
}

export const DENIED_RESULT_TEXT =
  'The user denied permission for this action. Do not retry it; try a different approach or finish.';

/**
 * Structural termination (the Cline/OpenHands pattern): the session ends when
 * the model CALLS finish — "no tool call" becomes a protocol violation to
 * remind about, not a phrase to interpret.
 */
export const FINISH_TOOL: ToolDefinition = {
  name: 'finish',
  description:
    'Call this when the task is fully complete (or impossible to complete). This ends the session.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'What was done, the outcome, and anything the user should know.',
      },
    },
    required: ['summary'],
  },
  permission: 'read',
};
