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
