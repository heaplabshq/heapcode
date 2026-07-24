import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import fg from 'fast-glob';
import {
  applySearchReplace,
  checkSyntax,
  DEFAULT_IGNORE_GLOB,
  extractSymbols,
  findBestMatch,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from '@heapcode/core';
import type { SessionCheckpoint } from './checkpoint.js';
import { filterIgnored } from './ignoreFiles.js';
import { listSkillsFormatted, loadSkill } from './skills.js';

const MAX_READ_CHARS = 50_000;
// Above this, an unranged read_file returns an outline instead of the full text —
// SWE-agent's ACI work found this kind of windowed view (vs. dumping whole files)
// meaningfully improves an agent's ability to navigate large codebases cheaply.
const LARGE_FILE_LINES = 300;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_SEARCH_RESULTS = 40;
const MAX_SEARCH_FILES = 2_000;
const MAX_FETCH_CHARS = 20_000;
// A fast-apply model must re-emit the whole file — same ceiling inline-edit's own apply
// action uses, past which the round-trip cost outweighs skipping the merge and just failing.
const MAX_APPLY_MERGE_CHARS = 40_000;
const CWD_MARKER = '__HEAPCODE_CWD__';

function truncate(content: string): string {
  if (content.length <= MAX_OUTPUT_CHARS) return content;
  return content.slice(0, MAX_OUTPUT_CHARS / 2) + '\n…[output truncated]…\n' + content.slice(-MAX_OUTPUT_CHARS / 2);
}

/** Builds the tool-facing result text/error flag for a finished (or interrupted) command. */
function buildCommandResult(opts: {
  content: string;
  exitCode: number | undefined;
  stoppedByUser: boolean;
  timedOut: boolean;
  timeoutSec: number;
}): ToolResult {
  const { content, exitCode, stoppedByUser, timedOut, timeoutSec } = opts;
  if (stoppedByUser) {
    return { id: '', name: 'run_command', content: `Stopped by user.\n${content}`, isError: true };
  }
  if (timedOut) {
    return {
      id: '',
      name: 'run_command',
      content:
        `Command did not finish within ${timeoutSec}s and was killed — this usually means it's a ` +
        'long-running process (a dev server, watcher, REPL…) rather than a one-shot command. Don\'t run ' +
        'it again the same way; it will just time out again. Either tell the user to run it themselves, ' +
        `or start it in the background (e.g. append &) and verify separately with a short-lived check.\n${content}`,
      isError: true,
    };
  }
  return { id: '', name: 'run_command', content: `exit code: ${exitCode ?? 'unknown'}\n${content}`, isError: exitCode !== 0 };
}

/**
 * Node-native port of packages/vscode/src/agent/workspaceTools.ts's
 * agentToolDefinitions. Three tools are deliberately dropped from this list
 * — get_diagnostics, find_references, go_to_definition — since they're
 * deeply tied to VS Code's language-server command bus with no portable
 * fallback (docs/CLI_PLAN.md decisions log). get_symbols instead uses
 * core's own tree-sitter symbol extraction. delegate_task is CLI-M4 scope
 * (not implemented yet) so it's excluded too, rather than listed and failing.
 */
export const agentToolDefinitions: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read a file (or a line range of it). Returns content with line numbers. ' +
      'For files over ~300 lines, calling this with no range first returns a symbol outline ' +
      'instead of the full text — call again with start_line/end_line for the section you need, ' +
      'or repeat the unranged call to force the full contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path' },
        start_line: { type: 'number', description: 'Optional 1-based first line' },
        end_line: { type: 'number', description: 'Optional 1-based last line (inclusive)' },
      },
      required: ['path'],
    },
    permission: 'read',
  },
  {
    name: 'list_dir',
    description: 'List files and directories at a workspace-relative path (non-recursive).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path, "." for root' } },
      required: ['path'],
    },
    permission: 'read',
  },
  {
    name: 'search',
    description: 'Search file contents with a regex. Returns file:line matches.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression' },
        glob: { type: 'string', description: 'Optional file glob, e.g. "**/*.ts"' },
      },
      required: ['pattern'],
    },
    permission: 'read',
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    permission: 'write',
  },
  {
    name: 'edit_file',
    description:
      'Replace an exact section of a file. "search" must match existing content (whitespace-tolerant); provide enough surrounding lines to be unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        search: { type: 'string', description: 'Existing code to replace' },
        replace: { type: 'string', description: 'New code' },
      },
      required: ['path', 'search', 'replace'],
    },
    permission: 'write',
  },
  {
    name: 'rename_file',
    description: 'Rename or move a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, newPath: { type: 'string' } },
      required: ['path', 'newPath'],
    },
    permission: 'write',
  },
  {
    name: 'delete_file',
    description: 'Delete a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'destructive',
  },
  {
    name: 'semantic_search',
    description:
      'Search the codebase by meaning (embeddings), e.g. "where is authentication handled". Falls back to text search when no index exists.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Natural-language query' } },
      required: ['query'],
    },
    permission: 'read',
  },
  {
    name: 'repo_map',
    description:
      'Get an outline of the workspace: every file and its top-level symbols (functions, classes, methods) with line numbers — no code bodies. Use it to orient before searching, e.g. to check whether something already exists before writing it.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Optional path prefix to scope the map to a directory or file (e.g. "packages/core/src/rag"). Omit for the whole workspace.',
        },
      },
    },
    permission: 'read',
  },
  {
    name: 'run_command',
    description:
      'Run a shell command (npm/pnpm/git/etc). Returns stdout, stderr, and exit code. ' +
      'The working directory persists between calls (cd carries over); it starts at the workspace root. ' +
      'Prefer run_tests for the project\'s test suite. Package installs are checked against the ' +
      'registry first and blocked if the package name looks hallucinated.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    permission: 'execute',
  },
  {
    name: 'run_tests',
    description:
      'Run the project\'s test command (e.g. "npm test", "pytest", "cargo test", "go test ./...") ' +
      'and report pass/fail from the exit code. Use this — not run_command — to verify changes before finishing.',
    parameters: { type: 'object', properties: { command: { type: 'string', description: 'The test command to run' } }, required: ['command'] },
    permission: 'execute',
    verifies: true,
  },
  {
    name: 'check_package_exists',
    description:
      'Check whether a package name actually exists on npm or PyPI before adding it as a dependency — ' +
      'catches hallucinated package names before they\'re installed.',
    parameters: {
      type: 'object',
      properties: { registry: { type: 'string', enum: ['npm', 'pypi'] }, name: { type: 'string' } },
      required: ['registry', 'name'],
    },
    permission: 'execute',
  },
  {
    name: 'get_symbols',
    description:
      'Outline of a file: functions, classes, methods with their line numbers (tree-sitter based). Much cheaper than reading the whole file.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path' } }, required: ['path'] },
    permission: 'read',
  },
  {
    name: 'fetch_url',
    description: 'Fetch a web page or API over HTTP(S) — documentation, READMEs, API responses. HTML is reduced to readable text.',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'http(s):// URL' } }, required: ['url'] },
    permission: 'execute',
    // Arbitrary third-party content — same injection posture as MCP (PLAN.md M7).
    untrustedOutput: true,
  },
  {
    name: 'multi_edit',
    description: 'Apply several search/replace edits to one file atomically (all succeed or none are written). Same matching rules as edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: { search: { type: 'string', description: 'Existing code to replace' }, replace: { type: 'string', description: 'New code' } },
            required: ['search', 'replace'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    permission: 'write',
  },
  {
    name: 'create_directory',
    description: 'Create a directory (and any missing parents).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'write',
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a clarifying question when blocked on a decision only they can make (ambiguous requirements, destructive trade-offs). Use sparingly — prefer sensible defaults.',
    parameters: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, description: 'Optional short answer choices' } },
      required: ['question'],
    },
    permission: 'read',
  },
  {
    name: 'list_skills',
    description:
      'List available Skills (name + description) from .claude/skills/ (project) and ~/.claude/skills/ ' +
      '(personal) — the same convention Claude Code itself uses. Skills are model-invoked: call this early, ' +
      'and if one\'s description matches the current task, call load_skill on it before proceeding.',
    parameters: { type: 'object', properties: {} },
    permission: 'read',
  },
  {
    name: 'load_skill',
    description:
      'Load a Skill\'s full instructions by name (from list_skills). If the instructions reference a bundled ' +
      'file (e.g. "see FORMS.md"), call this again with that file as `resource` to read it.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name, from list_skills' }, resource: { type: 'string', description: 'Optional: relative path to a file bundled in the skill\'s own folder' } },
      required: ['name'],
    },
    permission: 'read',
  },
];

/**
 * When an edit_file search misses, locate the closest matching line and show
 * the model what that region of the file actually looks like — most misses
 * are stale/hallucinated context, and this lets the model self-correct in
 * one turn instead of blindly re-reading.
 */
function nearbyHint(content: string, search: string): string {
  const anchor = search.split('\n').find((l) => l.trim().length > 8);
  if (!anchor) return '';
  const match = findBestMatch(content, anchor.trim());
  if (!match) return '';
  const lines = content.split('\n');
  let offset = 0;
  let matchLine = 0;
  for (let i = 0; i < lines.length; i++) {
    offset += lines[i]!.length + 1;
    if (offset > match.start) {
      matchLine = i;
      break;
    }
  }
  const start = Math.max(0, matchLine - 6);
  const end = Math.min(lines.length, matchLine + 7);
  const snippet = lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}\t${l}`)
    .join('\n');
  return `The closest matching region is:\n${snippet}\n`;
}

/**
 * The "update" fed to the fast-apply model when edit_file's exact match fails —
 * gives it both what should disappear and what should appear, since the search
 * text alone drifting slightly from the file is exactly why the deterministic
 * match missed in the first place.
 */
function buildEditSnippet(search: string, replace: string): string {
  return `Replace this code:\n${search}\n\nwith this code:\n${replace}`;
}

export class WorkspaceToolExecutor {
  /** run_command working directory — persists across calls within a session. */
  private cwd: string;
  /** Files already shown as an outline (by path) — the next unranged read_file gets the full text. */
  private readonly outlinedFiles = new Set<string>();

  /**
   * `root` must already be canonicalized (see paths.ts's `canonicalize()`) —
   * callers that also construct a SessionCheckpoint/ShadowGit against the
   * same workspace must pass them the exact same canonicalized string, or
   * path comparisons between the two silently stop matching (a real bug
   * this caught in testing: a shell's own $PWD is always symlink-resolved,
   * e.g. macOS's /var is a symlink to /private/var, so an un-resolved root
   * would never match run_command's cwd-jail check under a symlinked root).
   * Canonicalizing once at the single entry point (cli.tsx) rather than
   * separately inside each class is what keeps them consistent.
   */
  constructor(
    private readonly root: string,
    private readonly checkpoint: SessionCheckpoint,
    private readonly commandTimeoutMs: number,
    private readonly semanticSearch?: (query: string) => Promise<string>,
    private readonly repoMap?: (pathPrefix?: string) => string,
    /** Fast-apply merge (applyModel/applyProfile role) — edit_file's fallback when exact search/replace fails to match. */
    private readonly applyMerge?: (original: string, updateSnippet: string) => Promise<string | undefined>,
  ) {
    this.cwd = root;
  }

  /** Human-readable "what will happen", shown in permission prompts and tool chips. */
  describe(call: ToolCall): string {
    const a = call.args as Record<string, string | number | undefined>;
    switch (call.name) {
      case 'read_file':
        return a.start_line || a.end_line ? `Read ${a.path} (lines ${a.start_line ?? 1}–${a.end_line ?? 'end'})` : `Read ${a.path}`;
      case 'list_dir':
        return `List ${a.path === '.' || !a.path ? 'workspace root' : a.path}`;
      case 'search':
        return `Search for /${a.pattern}/${a.glob ? ` in ${a.glob}` : ''}`;
      case 'semantic_search':
        return `Semantic search: "${a.query}"`;
      case 'repo_map':
        return a.path ? `Repo map: ${a.path}` : 'Repo map';
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
      case 'fetch_url':
        return `Fetch ${a.url}`;
      case 'multi_edit': {
        const count = Array.isArray(call.args.edits) ? (call.args.edits as unknown[]).length : 0;
        return `Edit ${a.path} (${count} edits)`;
      }
      case 'create_directory':
        return `Create directory ${a.path}`;
      case 'ask_user':
        return `Ask: ${String(a.question ?? '').slice(0, 80)}`;
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
    const fail = (content: string): ToolResult => ({ id: call.id, name: call.name, content, isError: true });

    const a = call.args as Record<string, string | undefined>;
    switch (call.name) {
      case 'read_file': {
        const abs = this.resolve(a.path);
        const allLines = (await readFile(abs, 'utf8')).split('\n');

        const rangeGiven = Boolean(a.start_line || a.end_line);
        if (!rangeGiven && allLines.length > LARGE_FILE_LINES && !this.outlinedFiles.has(abs)) {
          this.outlinedFiles.add(abs);
          const outline = await this.symbolOutline(abs);
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
        const numbered = text.split('\n').map((l, i) => `${start + i}\t${l}`).join('\n');
        return ok(numbered + (truncated ? '\n…[truncated]' : ''));
      }
      case 'list_dir': {
        const abs = this.resolve(a.path ?? '.');
        const entries = await readdir(abs, { withFileTypes: true });
        return ok(
          entries
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
            .sort()
            .join('\n') || '(empty)',
        );
      }
      case 'search':
        return ok(await this.search(a.pattern ?? '', a.glob));
      case 'semantic_search': {
        const query = a.query ?? '';
        if (!query.trim()) return fail('Missing "query" argument.');
        if (this.semanticSearch) {
          const formatted = await this.semanticSearch(query);
          if (formatted) return ok(formatted);
        }
        const words = query.split(/\W+/).filter((w) => w.length > 3);
        if (words.length === 0) return ok('No semantic index and query too short for text search.');
        return ok(await this.search(words.join('|')));
      }
      case 'repo_map': {
        if (!this.repoMap) return ok('Repo map is not available.');
        const map = this.repoMap(a.path);
        return ok(map || 'Repo map is empty — still building, or no indexable files found.');
      }
      case 'write_file': {
        const abs = this.resolve(a.path);
        const content = a.content ?? '';
        const syntaxError = await checkSyntax(a.path ?? '', content);
        if (syntaxError) return fail(`${syntaxError} The file was NOT written — fix the syntax and try again.`);
        await this.checkpoint.recordBeforeChange(abs);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
        return ok(`Wrote ${a.path}.`);
      }
      case 'edit_file': {
        const abs = this.resolve(a.path);
        const current = await readFile(abs, 'utf8');
        const search = String(a.search ?? '');
        const replace = String(a.replace ?? '');
        const match = findBestMatch(current, search);
        if (match?.ambiguous) {
          return fail(
            `The "search" text matches ${match.occurrences} different places in ${a.path} — refusing to guess ` +
              'which one. Include more surrounding lines so the search text is unique to the intended location.',
          );
        }
        let next = applySearchReplace(current, search, replace);
        let viaApplyModel = false;
        if (next === undefined && this.applyMerge && current.length <= MAX_APPLY_MERGE_CHARS) {
          const merged = await this.applyMerge(current, buildEditSnippet(search, replace));
          if (merged !== undefined && merged.trim() && merged !== current) {
            next = merged;
            viaApplyModel = true;
          }
        }
        if (next === undefined) {
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
        await this.checkpoint.recordBeforeChange(abs);
        await writeFile(abs, next, 'utf8');
        return ok(`Edited ${a.path}.${viaApplyModel ? ' (search text did not match exactly — merged via the fast-apply model instead)' : ''}`);
      }
      case 'rename_file': {
        const from = this.resolve(a.path);
        const to = this.resolve(a.newPath);
        await this.checkpoint.recordBeforeChange(from);
        await this.checkpoint.recordBeforeChange(to);
        await mkdir(path.dirname(to), { recursive: true });
        await rename(from, to);
        return ok(`Renamed ${a.path} → ${a.newPath}.`);
      }
      case 'delete_file': {
        const abs = this.resolve(a.path);
        await this.checkpoint.recordBeforeChange(abs);
        await rm(abs, { force: true });
        return ok(`Deleted ${a.path}.`);
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
        return this.runCommand(command, signal);
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
        const abs = this.resolve(a.path);
        const outline = await this.symbolOutline(abs);
        if (!outline) return ok('No symbols found (unsupported file type, parse failure, or an empty file).');
        return ok(outline.join('\n'));
      }
      case 'fetch_url':
        return fetchUrl(a.url ?? '').then(ok, (err: Error) => fail(err.message));
      case 'multi_edit': {
        const abs = this.resolve(a.path);
        const edits = Array.isArray(call.args.edits) ? (call.args.edits as Array<{ search?: unknown; replace?: unknown }>) : [];
        if (edits.length === 0) return fail('No edits given.');
        const original = await readFile(abs, 'utf8');
        let text = original;
        for (let i = 0; i < edits.length; i++) {
          const search = String(edits[i]!.search ?? '');
          const match = findBestMatch(text, search);
          if (match?.ambiguous) {
            return fail(
              `Edit ${i + 1}/${edits.length}: "search" matches ${match.occurrences} different places in ` +
                `${a.path} (earlier edits were NOT applied) — refusing to guess which one. Include more ` +
                'surrounding lines so the search text is unique to the intended location.',
            );
          }
          const next = applySearchReplace(text, search, String(edits[i]!.replace ?? ''));
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
        await this.checkpoint.recordBeforeChange(abs);
        await writeFile(abs, text, 'utf8');
        return ok(`Applied ${edits.length} edits to ${a.path}.`);
      }
      case 'create_directory': {
        await mkdir(this.resolve(a.path), { recursive: true });
        return ok(`Created ${a.path}.`);
      }
      case 'list_skills':
        return ok(await listSkillsFormatted(this.root));
      case 'load_skill':
        return loadSkill(this.root, a.name ?? '', a.resource).then(ok, (err: Error) => fail(err.message));
      default:
        return fail(`Tool "${call.name}" is not implemented.`);
    }
  }

  private async symbolOutline(absPath: string): Promise<string[] | undefined> {
    let content: string;
    try {
      content = await readFile(absPath, 'utf8');
    } catch {
      return undefined;
    }
    const symbols = await extractSymbols(absPath, content);
    if (symbols.length === 0) return undefined;
    return symbols.map((s) => `${s.kind} ${s.name} (line ${s.line})`);
  }

  /**
   * Resolve a workspace-relative path, jailed to the workspace root — blocks
   * lexical escapes (`../../etc/passwd`, absolute paths outside root) by
   * checking the normalized result, not the raw string. Same as the ported
   * vscode original: this is a lexical check, not a filesystem one — a
   * symlink *inside* the root whose target resolves outside it is still
   * followed (no fs.realpath check here). Not a CLI-specific gap; tracked as
   * a real fix in docs/CLI_PLAN.md's Backlog if worth doing for both surfaces.
   */
  private resolve(rel: string | undefined): string {
    if (!rel) throw new Error('Missing "path" argument.');
    const resolved = path.resolve(this.root, rel);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`Path escapes the workspace: ${rel}`);
    }
    return resolved;
  }

  private async search(pattern: string, glob?: string): Promise<string> {
    if (!pattern) throw new Error('Missing "pattern" argument.');
    const regex = new RegExp(pattern);
    const found = await fg(glob || '**/*', {
      cwd: this.root,
      ignore: [DEFAULT_IGNORE_GLOB],
      absolute: true,
      onlyFiles: true,
      dot: true,
      suppressErrors: true,
      followSymbolicLinks: false,
    });
    const files = (await filterIgnored(this.root, found)).slice(0, MAX_SEARCH_FILES);
    const results: string[] = [];
    for (const file of files) {
      if (results.length >= MAX_SEARCH_RESULTS) break;
      let text: string;
      try {
        const buf = await readFile(file);
        if (buf.byteLength > 1_000_000) continue;
        text = buf.toString('utf8');
        if (text.includes('\0')) continue; // binary
      } catch {
        continue;
      }
      const lines = text.split('\n');
      const rel = path.relative(this.root, file).replace(/\\/g, '/');
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

  /** Runs commands via a plain child process — see docs/CLI_PLAN.md decisions log on why this (not a terminal-streaming path) is the CLI's only run_command implementation. */
  private runCommand(command: string, signal?: AbortSignal): Promise<ToolResult> {
    if (!command) {
      return Promise.resolve({ id: '', name: 'run_command', content: 'Missing "command" argument.', isError: true });
    }
    // POSIX: echo the final $PWD behind a marker so `cd` persists to the next call.
    const trackCwd = process.platform !== 'win32';
    const wrapped = trackCwd ? `${command}\n__heapcode_ec=$?; echo "${CWD_MARKER}$PWD"; exit $__heapcode_ec` : command;
    return new Promise((resolvePromise) => {
      const child = spawn(wrapped, { shell: true, cwd: this.cwd, env: process.env });
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
        child.kill('SIGKILL');
      }, this.commandTimeoutMs);

      // Stop must be able to interrupt a command that outlives the LLM
      // turn — a dev server, a stuck build — not just abort the next fetch.
      const onAbort = () => {
        stoppedByUser = true;
        child.kill('SIGKILL');
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
          if (nextCwd === this.root || nextCwd.startsWith(this.root + path.sep)) {
            this.cwd = nextCwd;
          }
        }
        resolvePromise(
          buildCommandResult({
            content: truncate(out.trim() || '(no output)'),
            exitCode: code ?? undefined,
            stoppedByUser,
            timedOut,
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

/** Fetch a URL; HTML is reduced to readable text. Throws with a useful message. */
async function fetchUrl(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs are supported.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'HeapCode-Agent', accept: 'text/html, text/plain, application/json, */*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    const type = res.headers.get('content-type') ?? '';
    let body = await res.text();
    if (type.includes('html')) body = htmlToText(body);
    if (body.length > MAX_FETCH_CHARS) body = body.slice(0, MAX_FETCH_CHARS) + '\n…[truncated]';
    return body.trim() || '(empty response)';
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(`Timed out fetching ${url}`);
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timeout);
  }
}

/** Install-command shapes we recognize per package registry (order doesn't matter — first match wins). */
const INSTALL_PATTERNS: Array<{ re: RegExp; registry: 'npm' | 'pypi' }> = [
  { re: /^(?:npm|pnpm)\s+(?:install|i|add)\b/, registry: 'npm' },
  { re: /^yarn\s+add\b/, registry: 'npm' },
  { re: /^(?:pip3?|python3?\s+-m\s+pip)\s+install\b/, registry: 'pypi' },
  { re: /^poetry\s+add\b/, registry: 'pypi' },
];

/**
 * Extract package names from an install-shaped command, for the
 * hallucinated-package guard. Returns undefined when the command isn't an
 * install, installs from a file/lockfile (no new name being introduced), or
 * only references local paths/VCS URLs.
 */
function detectPackageInstall(command: string): { registry: 'npm' | 'pypi'; names: string[] } | undefined {
  const trimmed = command.trim();
  const matched = INSTALL_PATTERNS.find((p) => p.re.test(trimmed));
  if (!matched) return undefined;
  const rest = trimmed.replace(matched.re, '').trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const names: string[] = [];
  for (const t of tokens) {
    if (t.startsWith('-')) {
      // Installing from a requirements file/editable local path — not a named package to verify.
      if (['-r', '--requirement', '-e', '--editable'].includes(t)) return undefined;
      continue;
    }
    if (t === '.' || t.startsWith('./') || t.startsWith('../') || t.startsWith('/') || t.includes('://')) {
      continue; // local path or VCS/tarball URL — not a registry lookup
    }
    const name = matched.registry === 'npm' ? t.replace(/^(@?[^@]+).*$/, '$1') : t.split(/[=<>!~[]/)[0]!;
    if (name) names.push(name);
  }
  return names.length > 0 ? { registry: matched.registry, names } : undefined;
}

/** Best-effort registry lookup; network failures resolve to "exists" (fail open, never block on our own flakiness). */
async function checkPackageExists(registry: 'npm' | 'pypi', name: string): Promise<boolean> {
  if (!name) return true;
  const url =
    registry === 'pypi'
      ? `https://pypi.org/pypi/${encodeURIComponent(name)}/json`
      : `https://registry.npmjs.org/${name.startsWith('@') ? name.replace('/', '%2f') : encodeURIComponent(name)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res.ok;
  } catch {
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

/** Crude but dependency-free HTML → text: drop script/style, strip tags, decode entities. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n');
}
