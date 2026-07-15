import * as vscode from 'vscode';
import type { ToolDefinition } from '@heapcode/core';

/**
 * Bridges VS Code's Language Model Tools API (vscode.lm) into the agent:
 * any installed extension that registers a tool via `contributes.languageModelTools`
 * shows up in `vscode.lm.tools`, the same shared registry Copilot's "Configure Tools"
 * picker reads from. We surface those tools to our own agent loop too, gated through
 * the same permission system as everything else (permission: 'execute' — unknown
 * third-party behavior, same conservative default as MCP tools).
 */
const PREFIX = 'vslm__';

/**
 * Other AI coding-agent extensions register their own tools the same way we'd want to
 * consume everyone else's — but calling into them buys nothing: they duplicate tools we
 * already have (readFile, findFiles, applyPatch, …) and, worse, some (e.g. Claude Code's
 * own subagent/skill tools) almost certainly assume they're running inside that
 * extension's own session and would behave unpredictably invoked from outside it.
 */
const EXCLUDED_EXTENSIONS = new Set(['github.copilot-chat', 'anthropic.claude-code']);

export function getLmToolDefinitions(): ToolDefinition[] {
  const meta = buildToolMetaIndex();
  return vscode.lm.tools
    .filter((t) => !meta.get(t.name)?.excluded)
    .map((t) => ({
      name: sanitize(`${PREFIX}${t.name}`),
      description: `[VS Code tool] ${t.description}`,
      parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
      permission: 'execute',
    }));
}

export function isLmTool(name: string): boolean {
  return name.startsWith(PREFIX);
}

interface LmToolMeta {
  /** The contributing extension's display name — e.g. "GitHub Copilot Chat", "Python". */
  extensionLabel: string;
  /** Friendly name from the extension's own manifest, when it declared one. */
  displayName?: string;
  userDescription?: string;
  /** From a known AI coding-agent extension — excluded from our bridge (see EXCLUDED_EXTENSIONS). */
  excluded: boolean;
}

/**
 * package.json `contributes.languageModelTools` entries carry the friendly name/description
 * that `vscode.lm.tools` itself doesn't expose — cross-reference every installed extension's
 * manifest by tool name to recover them (and which extension owns each tool, for grouping
 * and exclusion).
 */
function buildToolMetaIndex(): Map<string, LmToolMeta> {
  const index = new Map<string, LmToolMeta>();
  for (const ext of vscode.extensions.all) {
    const contributed = ext.packageJSON?.contributes?.languageModelTools as
      | Array<{ name?: string; displayName?: string; userDescription?: string }>
      | undefined;
    if (!Array.isArray(contributed) || contributed.length === 0) continue;
    const extensionLabel: string = ext.packageJSON?.displayName ?? ext.packageJSON?.name ?? ext.id;
    const excluded = EXCLUDED_EXTENSIONS.has(ext.id.toLowerCase());
    for (const t of contributed) {
      if (!t.name) continue;
      index.set(t.name, {
        extensionLabel,
        displayName: t.displayName,
        userDescription: t.userDescription,
        excluded,
      });
    }
  }
  return index;
}

export interface LmToolGroup {
  label: string;
  tools: Array<{ name: string; label: string; description: string }>;
}

/** VS Code LM tools grouped by the extension that registered them, with friendly names where declared. */
export function getLmToolGroups(): LmToolGroup[] {
  const meta = buildToolMetaIndex();
  const groups = new Map<string, LmToolGroup>();
  for (const t of vscode.lm.tools) {
    const info = meta.get(t.name);
    if (info?.excluded) continue;
    const groupLabel = info?.extensionLabel ?? 'VS Code';
    if (!groups.has(groupLabel)) groups.set(groupLabel, { label: groupLabel, tools: [] });
    groups.get(groupLabel)!.tools.push({
      name: sanitize(`${PREFIX}${t.name}`),
      label: info?.displayName ?? t.name,
      description: info?.userDescription ?? t.description,
    });
  }
  return [...groups.values()];
}

export async function callLmTool(name: string, args: Record<string, unknown>): Promise<string> {
  const info = vscode.lm.tools.find((t) => sanitize(`${PREFIX}${t.name}`) === name);
  if (!info) throw new Error(`VS Code tool "${name.slice(PREFIX.length)}" is no longer available.`);
  if (buildToolMetaIndex().get(info.name)?.excluded) {
    throw new Error(`VS Code tool "${info.name}" is from an excluded extension and cannot be called.`);
  }

  const result = await vscode.lm.invokeTool(info.name, {
    input: args,
    toolInvocationToken: undefined,
  });
  return (
    result.content
      .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : JSON.stringify(part)))
      .join('\n') || '(no output)'
  );
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}
