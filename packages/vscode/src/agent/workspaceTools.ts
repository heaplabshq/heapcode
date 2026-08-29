import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  applySearchReplace,
  applySearchReplaceAll,
  describeAmbiguity,
  buildEditSnippet,
  checkPackageExists,
  checkSyntax,
  CWD_MARKER,
  DEFAULT_IGNORE_GLOB,
  detectPackageInstall,
  fetchUrl,
  formatSearchResults,
  isWebSearchEnabled,
  webSearch,
  WEB_SEARCH_DISABLED_NOTICE,
  type WebSearchConfig,
  findBestMatch,
  getSymbolsTool,
  DELEGATE_TASK_TOOL,
  killTree,
  LARGE_FILE_LINES,
  MAX_APPLY_MERGE_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_READ_CHARS,
  MAX_SEARCH_FILES,
  MAX_SEARCH_RESULTS,
  nearbyHint,
  PROTECTED_MANIFEST_FILES,
  sharedAgentTools as T,
  truncate,
  unifiedDiff,
  wantsReplaceAll,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from '@heapcode/core';
import type { SessionCheckpoint } from './checkpoint.js';
import { filterIgnored } from '../ignoreFiles.js';
import { listSkillsFormatted, loadSkill } from './skills.js';

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

const HEAPCODE_TERMINAL_NAME = 'Heap Code';
/** Grace period for shell integration to activate on a freshly created terminal. */
const SHELL_INTEGRATION_TIMEOUT_MS = 4_000;
/** After Ctrl+C, how long to wait before giving up on a process that won't die. */
const INTERRUPT_GRACE_MS = 5_000;

/**
 * The single terminal agent commands and the manual "Run in terminal" button
 * both use, so a user checking VS Code's terminal list sees one recognizable,
 * live session rather than a new one per run.
 */
export function getHeapCodeTerminal(cwd: vscode.Uri): vscode.Terminal {
  const existing = vscode.window.terminals.find(
    (t) => t.name === HEAPCODE_TERMINAL_NAME && t.exitStatus === undefined,
  );
  if (existing) return existing;
  return vscode.window.createTerminal({ name: HEAPCODE_TERMINAL_NAME, cwd });
}

/** Resolves once shell integration activates for `terminal`, or undefined if it never does within the grace period. */
function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs = SHELL_INTEGRATION_TIMEOUT_MS,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) return Promise.resolve(terminal.shellIntegration);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(undefined);
    }, timeoutMs);
    const sub = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === terminal) {
        clearTimeout(timer);
        sub.dispose();
        resolve(e.shellIntegration);
      }
    });
  });
}

/** Strips ANSI/OSC escape sequences (colors, cursor moves, shell-integration markers) from raw terminal output. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1B\][^\x07\x1B]*(\x07|\x1B\\)/g, '') // OSC ... BEL | ST  (incl. shell-integration markers)
    .replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, '') // CSI sequences (colors, cursor movement)
    .replace(/\x1B[()#][0-9A-Za-z]/g, '') // charset selection
    .replace(/\r/g, '');
}

/**
 * Kept here rather than shared with the CLI: the extension runs commands in a
 * real terminal when shell integration is available, which it cannot always
 * interrupt — `gaveUp` says so, and the wording ("interrupted", "may still be
 * running in the Heap Code terminal") is only true of that path. The CLI kills
 * the process group outright and tells the model the command was killed.
 */
/** Builds the tool-facing result text/error flag for a finished (or interrupted) command, uniformly across both execution paths. */
function buildCommandResult(opts: {
  content: string;
  exitCode: number | string | undefined;
  stoppedByUser: boolean;
  timedOut: boolean;
  gaveUp: boolean;
  timeoutSec: number;
}): ToolResult {
  const { content, exitCode, stoppedByUser, timedOut, gaveUp, timeoutSec } = opts;
  if (stoppedByUser) {
    return {
      id: '',
      name: 'run_command',
      content: `Stopped by user.${gaveUp ? ' It may still be running in the "Heap Code" terminal — check there or interrupt it manually if needed.' : ''}\n${content}`,
      isError: true,
    };
  }
  if (timedOut) {
    return {
      id: '',
      name: 'run_command',
      content:
        `Command did not finish within ${timeoutSec}s and was interrupted — this usually means it's a ` +
        'long-running process (a dev server, watcher, REPL…) rather than a one-shot command. Don\'t run ' +
        'it again the same way; it will just time out again. Either tell the user to run it themselves, ' +
        'or start it in the background (e.g. append &) and verify separately with a short-lived check ' +
        `(e.g. curl the port).${gaveUp ? ' It may still be running in the "Heap Code" terminal.' : ''}\n${content}`,
      isError: true,
    };
  }
  return {
    id: '',
    name: 'run_command',
    content: `exit code: ${exitCode ?? 'unknown'}\n${content}`,
    isError: exitCode !== 0,
  };
}

/**
 * Tools only this host can offer: three backed by VS Code's language-server
 * command bus, with no portable CLI equivalent. delegate_task is shared from
 * core like the rest, but not baked into its standing list — see its comment
 * there.
 */
const GET_DIAGNOSTICS_TOOL: ToolDefinition = {
    name: 'get_diagnostics',
    description: 'Get current errors/warnings from the IDE (optionally for one file).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional workspace-relative path' } },
    },
    permission: 'read',
};

const FIND_REFERENCES_TOOL: ToolDefinition = {
    name: 'find_references',
    description:
      'Find all usages of a symbol across the workspace (language-server powered — exact, not text search).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File where the symbol appears' },
        symbol: { type: 'string', description: 'The identifier to look up' },
        line: { type: 'number', description: 'Optional 1-based line to disambiguate' },
      },
      required: ['path', 'symbol'],
    },
    permission: 'read',
};

const GO_TO_DEFINITION_TOOL: ToolDefinition = {
    name: 'go_to_definition',
    description: 'Find where a symbol used in a file is defined (language-server powered).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File where the symbol is used' },
        symbol: { type: 'string', description: 'The identifier to resolve' },
        line: { type: 'number', description: 'Optional 1-based line to disambiguate' },
      },
      required: ['path', 'symbol'],
    },
    permission: 'read',
};

/**
 * The tools this host offers, composed from core's shared schemas with the
 * editor-only ones interleaved in their established positions — the order
 * tools are offered in is part of the prompt, so it is spelled out rather
 * than derived.
 */
export const agentToolDefinitions: ToolDefinition[] = [
  T.read_file,
  T.list_dir,
  T.search,
  GET_DIAGNOSTICS_TOOL,
  T.write_file,
  T.edit_file,
  T.rename_file,
  T.delete_file,
  T.semantic_search,
  T.repo_map,
  T.run_command,
  T.run_tests,
  T.check_package_exists,
  getSymbolsTool(
    'Outline of a file from the language server: functions, classes, methods with their line ranges. Much cheaper ' +
      'than reading the whole file. Use it to pick where to read before reading, and to see what a file holds when ' +
      'you need one thing from it — a symbol name plus its line range turns into a ranged read_file.',
  ),
  FIND_REFERENCES_TOOL,
  GO_TO_DEFINITION_TOOL,
  T.fetch_url,
  // Always offered, executed only when configured — see the CLI executor's
  // note and core's webSearch.ts for why it stays visible while disabled.
  T.web_search,
  T.multi_edit,
  T.create_directory,
  T.ask_user,
  // Core's shared definition — the extension used to carry its own wording,
  // and the two drifted. See DELEGATE_TASK_TOOL in core for why it is not in
  // sharedAgentTools.
  DELEGATE_TASK_TOOL,
  T.list_skills,
  T.load_skill,
];

export class WorkspaceToolExecutor {
  /** run_command working directory — persists across calls within a session. */
  private cwd: string;
  /** Files already shown as an outline (by URI) — the next unranged read_file gets the full text. */
  private readonly outlinedFiles = new Set<string>();

  constructor(
    private readonly root: vscode.Uri,
    private readonly checkpoint: SessionCheckpoint,
    private readonly commandTimeoutMs: number,
    private readonly semanticSearch?: (query: string) => Promise<string>,
    private readonly repoMap?: (pathPrefix?: string) => string,
    /** Fast-apply merge (applyModel/applyProfile role) — edit_file's fallback when exact search/replace fails to match. */
    private readonly applyMerge?: (original: string, updateSnippet: string) => Promise<string | undefined>,
    /** Resolves web-search config + key at call time, so enabling it mid-session takes effect. */
    private readonly webSearchSettings?: () => Promise<{ config: WebSearchConfig; apiKey?: string }>,
  ) {
    this.cwd = root.fsPath;
  }

  /** Human-readable "what will happen", shown in permission prompts and tool chips. */
  describe(call: ToolCall): string {
    const a = call.args as Record<string, string | number | undefined>;
    switch (call.name) {
      case 'read_file':
        return a.start_line || a.end_line
          ? `Read ${a.path} (lines ${a.start_line ?? 1}–${a.end_line ?? 'end'})`
          : `Read ${a.path}`;
      case 'list_dir':
        return `List ${a.path === '.' || !a.path ? 'workspace root' : a.path}`;
      case 'search':
        return `Search for /${a.pattern}/${a.glob ? ` in ${a.glob}` : ''}`;
      case 'semantic_search':
        return `Semantic search: "${a.query}"`;
      case 'repo_map':
        return a.path ? `Repo map: ${a.path}` : 'Repo map';
      case 'get_diagnostics':
        return a.path ? `Check problems in ${a.path}` : 'Check workspace problems';
      case 'write_file':
        return `Write ${String(a.content ?? '').split('\n').length} lines to ${a.path}`;
      case 'edit_file': {
        const searchLines = String(a.search ?? '').split('\n').length;
        const replaceLines = String(a.replace ?? '').split('\n').length;
        return `Edit ${a.path} (replace ${searchLines} lines with ${replaceLines})`;
      }
      case 'rename_file':
        return `Rename ${a.path} → ${a.newPath}`;
      case 'delete_file':
        return `Delete ${a.path}`;
      case 'run_command':
        return `Run: ${a.command}`;
      case 'run_tests':
        return `Run tests: ${a.command}`;
      case 'check_package_exists':
        return `Check if ${a.name} exists on ${a.registry}`;
      case 'get_symbols':
        return `Outline ${a.path}`;
      case 'find_references':
        return `Find references to ${a.symbol} (from ${a.path})`;
      case 'go_to_definition':
        return `Find definition of ${a.symbol} (from ${a.path})`;
      case 'fetch_url':
        return `Fetch ${a.url}`;
      case 'web_search':
        return `Web search: "${a.query}"`;
      case 'multi_edit': {
        const count = Array.isArray(call.args.edits) ? call.args.edits.length : 0;
        return `Edit ${a.path} (${count} edits)`;
      }
      case 'create_directory':
        return `Create directory ${a.path}`;
      case 'ask_user':
        return `Ask: ${String(a.question ?? '').slice(0, 80)}`;
      case 'delegate_task':
        return `Delegate: "${String(a.task ?? '').slice(0, 100)}"${a.persona ? ` (${a.persona})` : ''}`;
      case 'list_skills':
        return 'List available skills';
      case 'load_skill':
        return `Load skill "${a.name}"${a.resource ? ` (${a.resource})` : ''}`;
      default:
        return `${call.name} ${JSON.stringify(call.args)}`;
    }
  }

  async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const ok = (content: string): ToolResult => ({ id: call.id, name: call.name, content });
    const fail = (content: string): ToolResult => ({
      id: call.id,
      name: call.name,
      content,
      isError: true,
    });

    const a = call.args as Record<string, string | undefined>;
    switch (call.name) {
      case 'read_file': {
        const uri = this.resolve(a.path);
        const bytes = await vscode.workspace.fs.readFile(uri);
        const allLines = new TextDecoder().decode(bytes).split('\n');

        const rangeGiven = Boolean(a.start_line || a.end_line);
        const key = uri.toString();
        if (!rangeGiven && allLines.length > LARGE_FILE_LINES && !this.outlinedFiles.has(key)) {
          this.outlinedFiles.add(key);
          const outline = await getSymbolOutline(uri);
          if (outline) {
            return ok(
              `${a.path} has ${allLines.length} lines — showing its outline instead of the full ` +
                'contents to save context. Call read_file again with start_line/end_line for the ' +
                'section you need, or repeat this call with no range to force the full file.\n\n' +
                outline.join('\n'),
            );
          }
        }

        const start = Math.max(1, Number(a.start_line) || 1);
        const end = Math.min(allLines.length, Number(a.end_line) || allLines.length);
        let text = allLines.slice(start - 1, end).join('\n');
        let truncated = false;
        if (text.length > MAX_READ_CHARS) {
          text = text.slice(0, MAX_READ_CHARS);
          truncated = true;
        }
        const numbered = text
          .split('\n')
          .map((l, i) => `${start + i}\t${l}`)
          .join('\n');
        return ok(numbered + (truncated ? '\n…[truncated]' : ''));
      }
      case 'list_dir': {
        const uri = this.resolve(a.path ?? '.');
        const entries = await vscode.workspace.fs.readDirectory(uri);
        return ok(
          entries
            .map(([name, type]) => (type === vscode.FileType.Directory ? `${name}/` : name))
            .sort()
            .join('\n') || '(empty)',
        );
      }
      case 'search':
        return ok(await this.search(a.pattern ?? '', a.glob));
      case 'semantic_search': {
        const query = a.query ?? '';
        if (this.semanticSearch) {
          const formatted = await this.semanticSearch(query);
          if (formatted) return ok(formatted);
        }
        // No index — degrade to word-based text search.
        const words = query.split(/\W+/).filter((w) => w.length > 3);
        if (words.length === 0) return ok('No semantic index and query too short for text search.');
        return ok(await this.search(words.join('|')));
      }
      case 'repo_map': {
        if (!this.repoMap) return ok('Repo map is not available.');
        const map = this.repoMap(a.path);
        return ok(map || 'Repo map is empty — still building, or no indexable files found.');
      }
      case 'get_diagnostics': {
        const all = a.path
          ? [[this.resolve(a.path), vscode.languages.getDiagnostics(this.resolve(a.path))] as const]
          : vscode.languages.getDiagnostics();
        const lines: string[] = [];
        for (const [uri, diags] of all) {
          for (const d of diags) {
            const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
            if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
            lines.push(
              `${vscode.workspace.asRelativePath(uri, false)}:${d.range.start.line + 1} [${sev}] ${d.message}`,
            );
            if (lines.length >= 100) break;
          }
        }
        return ok(lines.join('\n') || 'No errors or warnings.');
      }
      case 'write_file': {
        const uri = this.resolve(a.path);
        if (PROTECTED_MANIFEST_FILES.has(path.basename(a.path ?? '')) && (await fileExists(uri))) {
          return fail(
            `Refusing to overwrite ${a.path} wholesale with write_file — it's a manifest/lockfile, and a full ` +
              'rewrite risks silently dropping fields the model did not fully re-derive (a real incident: this ' +
              'exact thing once dropped an unrelated "name" field from package.json). Use edit_file for a ' +
              'targeted change instead.',
          );
        }
        const content = a.content ?? '';
        const syntaxError = await checkSyntax(a.path ?? '', content);
        if (syntaxError) return fail(`${syntaxError} The file was NOT written — fix the syntax and try again.`);
        await this.checkpoint.recordBeforeChange(uri);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
        return ok(`Wrote ${a.path}.`);
      }
      case 'edit_file': {
        const uri = this.resolve(a.path);
        const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const search = String(a.search ?? '');
        const replace = String(a.replace ?? '');
        const match = findBestMatch(current, search);
        const all = wantsReplaceAll(call.args.replace_all);
        let replacedCount = 0;
        let next: string | undefined;
        if (all) {
          const result = applySearchReplaceAll(current, search, replace);
          next = result?.text;
          replacedCount = result?.count ?? 0;
        } else {
          next = applySearchReplace(current, search, replace);
        }
        let viaApplyModel = false;
        // The exact/fuzzy matcher didn't find "search" — before failing outright (which
        // costs a full agent-model retry round-trip), try the fast-apply model: it gets
        // both what should disappear and what should appear, so it can often place the
        // change even when the agent's search text has drifted slightly from the file.
        // The ambiguity refusal sits after this for the same reason.
        if (next === undefined && this.applyMerge && current.length <= MAX_APPLY_MERGE_CHARS) {
          const merged = await this.applyMerge(current, buildEditSnippet(search, replace));
          if (merged !== undefined && merged.trim() && merged !== current) {
            next = merged;
            viaApplyModel = true;
          }
        }
        if (next === undefined) {
          if (match?.ambiguous) return fail(describeAmbiguity(match, String(a.path)));
          return fail(
            `The "search" text was not found in ${a.path}. ${nearbyHint(current, search)}` +
              'Provide the exact existing code (copy it from read_file output, without the line numbers).',
          );
        }
        const beforeError = await checkSyntax(a.path ?? '', current);
        const afterError = !beforeError ? await checkSyntax(a.path ?? '', next) : undefined;
        if (afterError) {
          return fail(
            `${afterError} The edit was NOT applied — it would break previously-valid syntax. ` +
              'Provide a corrected search/replace.',
          );
        }
        await this.checkpoint.recordBeforeChange(uri);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
        const diff = unifiedDiff(current, next);
        return ok(
          `Edited ${a.path}.${all && !viaApplyModel ? ` (replaced ${replacedCount} occurrences)` : ''}${viaApplyModel ? ' (search text did not match exactly — merged via the fast-apply model instead)' : ''}${diff ? `\n\n${diff}` : ''}`,
        );
      }
      case 'rename_file': {
        const from = this.resolve(a.path);
        const to = this.resolve(a.newPath);
        await this.checkpoint.recordBeforeChange(from);
        await this.checkpoint.recordBeforeChange(to);
        await vscode.workspace.fs.rename(from, to, { overwrite: false });
        return ok(`Renamed ${a.path} → ${a.newPath}.`);
      }
      case 'delete_file': {
        const uri = this.resolve(a.path);
        await this.checkpoint.recordBeforeChange(uri);
        await vscode.workspace.fs.delete(uri, { useTrash: true });
        return ok(`Deleted ${a.path} (moved to trash).`);
      }
      case 'run_command': {
        const command = a.command ?? '';
        const install = detectPackageInstall(command);
        if (install) {
          const missing: string[] = [];
          for (const name of install.names) {
            const exists = await checkPackageExists(install.registry, name).catch(() => true);
            if (!exists) missing.push(name);
          }
          if (missing.length > 0) {
            const registryLabel = install.registry === 'pypi' ? 'PyPI' : 'npm';
            return fail(
              `Blocked: ${missing.join(', ')} could not be found on ${registryLabel} — this looks like ` +
                `a hallucinated package name. Double-check the spelling, or call check_package_exists ` +
                'to verify a name before retrying.',
            );
          }
        }
        // runCommand builds its result without the call (id: ''); restamp it,
        // as run_tests below already does — a tool result with no id cannot be
        // paired back to its tool_calls entry on the wire.
        return { ...(await this.runCommand(command, signal)), id: call.id };
      }
      case 'run_tests': {
        const result = await this.runCommand(a.command ?? '', signal);
        return { ...result, id: call.id, name: 'run_tests' };
      }
      case 'check_package_exists': {
        const registry = a.registry === 'pypi' ? 'pypi' : 'npm';
        const exists = await checkPackageExists(registry, a.name ?? '').catch(() => true);
        const registryLabel = registry === 'pypi' ? 'PyPI' : 'npm';
        return ok(
          exists
            ? `${a.name} exists on ${registryLabel}.`
            : `${a.name} was NOT found on ${registryLabel} — likely a hallucinated name. ` +
                'Do not install it; double-check the spelling or search for the correct package.',
        );
      }
      case 'get_symbols': {
        const uri = this.resolve(a.path);
        const outline = await getSymbolOutline(uri);
        if (!outline) {
          return ok('No symbols found (no language server for this file type, or an empty file).');
        }
        return ok(outline.join('\n'));
      }
      case 'find_references':
      case 'go_to_definition': {
        const uri = this.resolve(a.path);
        const pos = await findSymbolPosition(uri, a.symbol ?? '', Number(call.args.line) || undefined);
        if (!pos) return fail(`Symbol "${a.symbol}" not found in ${a.path}.`);
        const command =
          call.name === 'find_references'
            ? 'vscode.executeReferenceProvider'
            : 'vscode.executeDefinitionProvider';
        const locations = await vscode.commands.executeCommand<
          (vscode.Location | vscode.LocationLink)[]
        >(command, uri, pos);
        if (!locations || locations.length === 0) {
          return ok(
            `No ${call.name === 'find_references' ? 'references' : 'definition'} found for "${a.symbol}".`,
          );
        }
        return ok(await formatLocations(locations.slice(0, 50)));
      }
      case 'fetch_url':
        return fetchUrl(a.url ?? '').then(ok, (err: Error) => fail(err.message));
      case 'web_search': {
        const settings = await this.webSearchSettings?.();
        if (!settings || !isWebSearchEnabled(settings.config, settings.apiKey)) {
          return fail(WEB_SEARCH_DISABLED_NOTICE);
        }
        const query = String(a.query ?? '');
        try {
          const results = await webSearch(
            settings.config,
            settings.apiKey,
            query,
            typeof a.max_results === 'number' ? a.max_results : undefined,
          );
          return ok(formatSearchResults(query, results));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
      }
      case 'multi_edit': {
        const uri = this.resolve(a.path);
        const edits = Array.isArray(call.args.edits)
          ? (call.args.edits as Array<{ search?: unknown; replace?: unknown; replace_all?: unknown }>)
          : [];
        if (edits.length === 0) return fail('No edits given.');
        const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        let text = original;
        // Apply all in memory first — nothing is written unless every edit lands.
        for (let i = 0; i < edits.length; i++) {
          const search = String(edits[i]!.search ?? '');
          const replacement = String(edits[i]!.replace ?? '');
          const match = findBestMatch(text, search);
          const next =
            wantsReplaceAll(edits[i]!.replace_all)
              ? applySearchReplaceAll(text, search, replacement)?.text
              : applySearchReplace(text, search, replacement);
          if (next === undefined && match?.ambiguous) {
            return fail(
              describeAmbiguity(match, String(a.path), `Edit ${i + 1}/${edits.length}: "search"`) +
                ' Earlier edits were NOT applied.',
            );
          }
          if (next === undefined) {
            return fail(
              `Edit ${i + 1}/${edits.length}: "search" not found in ${a.path} (earlier edits were NOT applied). ` +
                `${nearbyHint(text, search)}` +
                'Provide the exact existing code for each edit.',
            );
          }
          text = next;
        }
        const beforeError = await checkSyntax(a.path ?? '', original);
        const afterError = !beforeError ? await checkSyntax(a.path ?? '', text) : undefined;
        if (afterError) {
          return fail(
            `${afterError} None of the edits were applied — the result would break previously-valid syntax. ` +
              'Provide corrected search/replace edits.',
          );
        }
        await this.checkpoint.recordBeforeChange(uri);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
        const diff = unifiedDiff(original, text);
        return ok(`Applied ${edits.length} edits to ${a.path}.${diff ? `\n\n${diff}` : ''}`);
      }
      case 'create_directory': {
        await vscode.workspace.fs.createDirectory(this.resolve(a.path));
        return ok(`Created ${a.path}.`);
      }
      case 'list_skills':
        return ok(await listSkillsFormatted());
      case 'load_skill':
        return loadSkill(a.name ?? '', a.resource).then(ok, (err: Error) => fail(err.message));
      default:
        return fail(`Tool "${call.name}" is not implemented.`);
    }
  }

  /** Resolve a workspace-relative path, jailed to the workspace root. */
  private resolve(rel: string | undefined): vscode.Uri {
    if (!rel) throw new Error('Missing "path" argument.');
    const rootPath = this.root.fsPath;
    const resolved = path.resolve(rootPath, rel);
    if (resolved !== rootPath && !resolved.startsWith(rootPath + path.sep)) {
      throw new Error(`Path escapes the workspace: ${rel}`);
    }
    return vscode.Uri.file(resolved);
  }

  private async search(pattern: string, glob?: string): Promise<string> {
    if (!pattern) throw new Error('Missing "pattern" argument.');
    const regex = new RegExp(pattern);
    const found = await vscode.workspace.findFiles(glob || '**/*', DEFAULT_IGNORE_GLOB, MAX_SEARCH_FILES);
    const files = await filterIgnored(this.root, found);
    const results: string[] = [];
    for (const file of files) {
      if (results.length >= MAX_SEARCH_RESULTS) break;
      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        if (bytes.byteLength > 1_000_000) continue;
        text = new TextDecoder().decode(bytes);
        if (text.includes('\0')) continue; // binary
      } catch {
        continue;
      }
      const lines = text.split('\n');
      const rel = vscode.workspace.asRelativePath(file, false);
      for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
        if (regex.test(lines[i]!)) {
          // ±2 lines of context — usually enough to judge a hit without a read_file round-trip.
          const from = Math.max(0, i - 2);
          const to = Math.min(lines.length - 1, i + 2);
          const block: string[] = [`${rel}:${i + 1}:`];
          for (let j = from; j <= to; j++) {
            block.push(`${j === i ? '>' : ' '} ${j + 1}\t${lines[j]!.slice(0, 200)}`);
          }
          results.push(block.join('\n'));
        }
      }
    }
    return results.join('\n--\n') || 'No matches.';
  }

  /**
   * Runs in the real, visible "Heap Code" terminal when shell integration is
   * available (so the user sees exactly what the agent runs, live, the same
   * place the manual "Run in terminal" button uses) — falling back to a
   * hidden child process only if shell integration never activates (e.g.
   * Command Prompt, or a shell without the integration script sourced).
   */
  private async runCommand(command: string, signal?: AbortSignal): Promise<ToolResult> {
    if (!command) {
      return { id: '', name: 'run_command', content: 'Missing "command" argument.', isError: true };
    }
    const viaTerminal = await this.runCommandInTerminal(command, signal).catch(() => undefined);
    return viaTerminal ?? this.runCommandHidden(command, signal);
  }

  private async runCommandInTerminal(
    command: string,
    signal?: AbortSignal,
  ): Promise<ToolResult | undefined> {
    const terminal = getHeapCodeTerminal(this.root);
    terminal.show(true);
    const shellIntegration = await waitForShellIntegration(terminal);
    if (!shellIntegration) return undefined;

    const execution = shellIntegration.executeCommand(command);
    const iterator = execution.read()[Symbol.asyncIterator]();

    let raw = '';
    let stoppedByUser = false;
    let timedOut = false;
    let interrupted = false;
    let gaveUp = false;
    let hardDeadline: Promise<'deadline'> | undefined;

    const interrupt = () => {
      if (interrupted) return;
      interrupted = true;
      terminal.sendText('\x03', false);
      hardDeadline = new Promise((r) => setTimeout(() => r('deadline'), INTERRUPT_GRACE_MS));
    };
    const onAbort = () => {
      stoppedByUser = true;
      interrupt();
    };
    signal?.addEventListener('abort', onAbort);
    const timeout = setTimeout(() => {
      timedOut = true;
      interrupt();
    }, this.commandTimeoutMs);

    const exitCodePromise = new Promise<number | undefined>((resolve) => {
      const sub = vscode.window.onDidEndTerminalShellExecution((e) => {
        if (e.execution === execution) {
          sub.dispose();
          resolve(e.exitCode);
        }
      });
    });

    try {
      while (true) {
        const next = hardDeadline
          ? await Promise.race([iterator.next(), hardDeadline])
          : await iterator.next();
        if (next === 'deadline') {
          gaveUp = true;
          void iterator.return?.();
          break;
        }
        if (next.done) break;
        raw += next.value;
        // Raw output carries escape sequences, so allow extra headroom before trimming.
        if (raw.length > MAX_OUTPUT_CHARS * 8) raw = raw.slice(-MAX_OUTPUT_CHARS * 4);
      }
    } catch {
      // the read stream can error if the terminal is closed mid-command
    }

    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    const exitCode = gaveUp
      ? undefined
      : await Promise.race([
          exitCodePromise,
          new Promise<undefined>((r) => setTimeout(() => r(undefined), 1_500)),
        ]);

    return buildCommandResult({
      content: truncate(stripAnsi(raw).trim() || '(no output)'),
      exitCode,
      stoppedByUser,
      timedOut,
      gaveUp,
      timeoutSec: this.commandTimeoutMs / 1000,
    });
  }

  private runCommandHidden(command: string, signal?: AbortSignal): Promise<ToolResult> {
    // POSIX: echo the final $PWD behind a marker so `cd` persists to the next call.
    const trackCwd = process.platform !== 'win32';
    const wrapped = trackCwd ? `${command}\n__heapcode_ec=$?; echo "${CWD_MARKER}$PWD"; exit $__heapcode_ec` : command;
    return new Promise((resolvePromise) => {
      // detached: the shell gets its own process group, so killTree below can
      // signal the whole group rather than just the wrapper (see killTree).
      const child = spawn(wrapped, {
        shell: true,
        cwd: this.cwd,
        env: process.env,
        detached: trackCwd,
      });
      let out = '';
      let stoppedByUser = false;
      let timedOut = false;
      const collect = (chunk: Buffer) => {
        out += chunk.toString();
        if (out.length > MAX_OUTPUT_CHARS * 4) {
          out = out.slice(0, MAX_OUTPUT_CHARS * 2) + '\n…\n' + out.slice(-MAX_OUTPUT_CHARS);
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      const timeout = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, this.commandTimeoutMs);

      // Stop must be able to interrupt a command that outlives the LLM
      // turn — a dev server, a stuck build — not just abort the next fetch.
      const onAbort = () => {
        stoppedByUser = true;
        killTree(child);
      };
      signal?.addEventListener('abort', onAbort);

      child.on('close', (code) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        const markerAt = out.lastIndexOf(CWD_MARKER);
        if (markerAt !== -1) {
          const nextCwd = out.slice(markerAt + CWD_MARKER.length).split('\n')[0]!.trim();
          out = out.slice(0, markerAt);
          // Jail the persisted cwd to the workspace.
          if (
            nextCwd === this.root.fsPath ||
            nextCwd.startsWith(this.root.fsPath + path.sep)
          ) {
            this.cwd = nextCwd;
          }
        }
        resolvePromise(
          buildCommandResult({
            content: truncate(out.trim() || '(no output)'),
            exitCode: code ?? undefined,
            stoppedByUser,
            timedOut,
            gaveUp: false,
            timeoutSec: this.commandTimeoutMs / 1000,
          }),
        );
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        resolvePromise({ id: '', name: 'run_command', content: err.message, isError: true });
      });
    });
  }
}

/** Symbol outline for a file, or undefined when the language server has none (e.g. JSON/plain text). */
async function getSymbolOutline(uri: vscode.Uri): Promise<string[] | undefined> {
  const symbols = await vscode.commands.executeCommand<
    (vscode.DocumentSymbol | vscode.SymbolInformation)[]
  >('vscode.executeDocumentSymbolProvider', uri);
  if (!symbols || symbols.length === 0) return undefined;
  return formatSymbols(symbols);
}

/** Flatten a DocumentSymbol tree (or SymbolInformation list) into outline lines. */
function formatSymbols(
  symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[],
  indent = '',
): string[] {
  const lines: string[] = [];
  for (const s of symbols) {
    const kind = vscode.SymbolKind[s.kind] ?? 'Symbol';
    if ('range' in s && 'children' in s) {
      lines.push(
        `${indent}${kind} ${s.name} (lines ${s.range.start.line + 1}-${s.range.end.line + 1})`,
      );
      if (lines.length < 400 && s.children.length > 0) {
        lines.push(...formatSymbols(s.children, indent + '  '));
      }
    } else {
      const loc = (s as vscode.SymbolInformation).location;
      lines.push(`${indent}${kind} ${s.name} (line ${loc.range.start.line + 1})`);
    }
    if (lines.length >= 400) break;
  }
  return lines;
}

/** Position of an identifier in a file — on `line` when given, else its first occurrence. */
async function findSymbolPosition(
  uri: vscode.Uri,
  symbol: string,
  line?: number,
): Promise<vscode.Position | undefined> {
  if (!symbol) return undefined;
  const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  const lines = text.split('\n');
  const pattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const search = (i: number): vscode.Position | undefined => {
    const col = lines[i]?.search(pattern) ?? -1;
    return col >= 0 ? new vscode.Position(i, col) : undefined;
  };
  if (line && line >= 1 && line <= lines.length) {
    const hit = search(line - 1);
    if (hit) return hit;
  }
  for (let i = 0; i < lines.length; i++) {
    const hit = search(i);
    if (hit) return hit;
  }
  return undefined;
}

/** "path:line: source-line" for reference/definition results. */
async function formatLocations(
  locations: (vscode.Location | vscode.LocationLink)[],
): Promise<string> {
  const out: string[] = [];
  const cache = new Map<string, string[]>();
  for (const loc of locations) {
    const uri = 'targetUri' in loc ? loc.targetUri : loc.uri;
    const range = 'targetUri' in loc ? loc.targetRange : loc.range;
    const rel = vscode.workspace.asRelativePath(uri, false);
    let lines = cache.get(uri.toString());
    if (!lines) {
      try {
        lines = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).split('\n');
      } catch {
        lines = [];
      }
      cache.set(uri.toString(), lines);
    }
    const lineText = lines[range.start.line]?.trim().slice(0, 160) ?? '';
    out.push(`${rel}:${range.start.line + 1}: ${lineText}`);
  }
  return out.join('\n');
}

