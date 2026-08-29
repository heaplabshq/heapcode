import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import fg from 'fast-glob';
import {
  applySearchReplace,
  applySearchReplaceAll,
  buildEditSnippet,
  describeAmbiguity,
  checkPackageExists,
  checkSyntax,
  CWD_MARKER,
  DEFAULT_IGNORE_GLOB,
  detectPackageInstall,
  extractSymbols,
  fetchUrl,
  findBestMatch,
  formatSearchResults,
  isWebSearchEnabled,
  getSymbolsTool,
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
  webSearch,
  WEB_SEARCH_DISABLED_NOTICE,
  type ToolCall,
  type ToolDefinition,
  type WebSearchConfig,
  type ToolResult,
} from '@heapcode/core';
import type { SessionCheckpoint } from './checkpoint.js';
import { filterIgnored } from './ignoreFiles.js';
import { listSkillsFormatted, loadSkill } from './skills.js';

/**
 * Every spelling of the system temp directory on this machine.
 *
 * Both the name and its target, because macOS reports `/var/folders/...` from
 * `tmpdir()` while the real path is `/private/var/folders/...` — and a path
 * the agent wrote as `/tmp/x` matches neither. Comparing one spelling against
 * the other is how a directory ends up refused for not being itself.
 */
let cachedTempRoots: string[] | undefined;
function tempRoots(): string[] {
  if (cachedTempRoots) return cachedTempRoots;
  const roots = new Set<string>();
  for (const candidate of [tmpdir(), '/tmp']) {
    const resolved = path.resolve(candidate);
    roots.add(resolved);
    try {
      roots.add(realpathSync.native(resolved));
    } catch {
      // Does not exist on this platform — the literal spelling still counts.
    }
  }
  cachedTempRoots = [...roots];
  return cachedTempRoots;
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Builds the tool-facing result text/error flag for a finished (or interrupted) command. */
function buildCommandResult(opts: {
  content: string;
  exitCode: number | undefined;
  stoppedByUser: boolean;
  timedOut: boolean;
  timeoutSec: number;
  /** Where the shell is now, relative to the workspace root — absent while it is still at the root. */
  cwd?: string;
}): ToolResult {
  const { content, exitCode, stoppedByUser, timedOut, timeoutSec, cwd } = opts;
  // Said on every command, not only the one that moved.
  //
  // The working directory persists between calls, which the tool description
  // has always stated — and stating it once, at the top of a long context,
  // against state that silently changes underneath is not enough. What
  // actually happened: `cd apps/web && npm run build` succeeded, and the next
  // call, `cd apps/web && npm run lint`, failed with "No such file or
  // directory" because the shell was already there. Three steps then went on
  // `pwd`, `ls`, and a retry. Twice in one run, three times in another.
  const where = cwd ? `\n(working directory: ${cwd})` : '';
  if (stoppedByUser) {
    return { id: '', name: 'run_command', content: `Stopped by user.\n${content}${where}`, isError: true };
  }
  if (timedOut) {
    return {
      id: '',
      name: 'run_command',
      content:
        `Command did not finish within ${timeoutSec}s and was killed — this usually means it's a ` +
        'long-running process (a dev server, watcher, REPL…) rather than a one-shot command. Don\'t run ' +
        'it again the same way; it will just time out again. Either tell the user to run it themselves, ' +
        `or start it in the background (e.g. append &) and verify separately with a short-lived check.\n${content}${where}`,
      isError: true,
    };
  }
  return {
    id: '',
    name: 'run_command',
    content: `exit code: ${exitCode ?? 'unknown'}\n${content}${where}`,
    isError: exitCode !== 0,
  };
}

/**
 * The tools this host offers, composed from core's shared schemas plus the
 * CLI's own get_symbols wording.
 *
 * Three of the extension's tools are deliberately absent — get_diagnostics,
 * find_references, go_to_definition — since they're deeply tied to VS Code's
 * language-server command bus with no portable fallback (docs/CLI_PLAN.md
 * decisions log); get_symbols instead uses core's own tree-sitter symbol
 * extraction. delegate_task is offered separately (see delegate.ts), since
 * its execution needs cross-cutting context this executor doesn't have.
 */
export const agentToolDefinitions: ToolDefinition[] = [
  T.read_file,
  T.list_dir,
  T.search,
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
    'Outline of a file: functions, classes, methods with their line numbers (tree-sitter based). Much cheaper than reading the whole file.',
  ),
  T.fetch_url,
  // Always offered, executed only when configured — the same posture as
  // delegate_task. A model that cannot see the tool has no way to know web
  // search is even a concept here, and a live session responded to that by
  // claiming it had searched; refusing the call with an explanation is what
  // makes it answer honestly instead.
  T.web_search,
  T.multi_edit,
  T.create_directory,
  T.ask_user,
  T.list_skills,
  T.load_skill,
];

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
    private applyMerge?: (original: string, updateSnippet: string) => Promise<string | undefined>,
    /** Resolves web-search config + key at call time, so enabling it mid-session takes effect. */
    private readonly webSearchSettings?: () => Promise<{ config: WebSearchConfig; apiKey?: string }>,
  ) {
    this.cwd = root;
  }

  /**
   * Late-binds the fast-apply fallback.
   *
   * The interactive CLI builds this executor before it has a daemon
   * connection, and reconnects when the profile changes — so it hands the
   * merge function over once there is something to call, rather than the
   * constructor pretending to have one.
   */
  setApplyMerge(fn?: (original: string, updateSnippet: string) => Promise<string | undefined>): void {
    this.applyMerge = fn;
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
      case 'web_search':
        return `Web search: "${a.query}"`;
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
        const abs = this.resolveForReading(a.path);
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
        if (PROTECTED_MANIFEST_FILES.has(path.basename(a.path ?? '')) && (await fileExists(abs))) {
          return fail(
            `Refusing to overwrite ${a.path} wholesale with write_file — it's a manifest/lockfile, and a full ` +
              'rewrite risks silently dropping fields the model did not fully re-derive (a real incident: this ' +
              'exact thing once dropped an unrelated "name" field from package.json). Use edit_file or multi_edit ' +
              'for a targeted change instead.',
          );
        }
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
        // The ambiguity refusal deliberately sits *after* the fast-apply attempt:
        // failing early skipped the one model that gets both the before and the
        // after text, and so is best placed to resolve exactly this case.
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
        await this.checkpoint.recordBeforeChange(abs);
        await writeFile(abs, next, 'utf8');
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
        const abs = this.resolve(a.path);
        const outline = await this.symbolOutline(abs);
        if (!outline) return ok('No symbols found (unsupported file type, parse failure, or an empty file).');
        return ok(outline.join('\n'));
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
        const abs = this.resolve(a.path);
        const edits = Array.isArray(call.args.edits)
          ? (call.args.edits as Array<{ search?: unknown; replace?: unknown; replace_all?: unknown }>)
          : [];
        if (edits.length === 0) return fail('No edits given.');
        const original = await readFile(abs, 'utf8');
        let text = original;
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
        await this.checkpoint.recordBeforeChange(abs);
        await writeFile(abs, text, 'utf8');
        const diff = unifiedDiff(original, text);
        return ok(`Applied ${edits.length} edits to ${a.path}.${diff ? `\n\n${diff}` : ''}`);
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

  /**
   * Same as `resolve`, plus the system temp directory.
   *
   * Reading only. The workspace jail is the whole of what stops a `read_file`
   * from returning `~/.ssh/id_rsa` or this machine's stored API keys, and
   * `read` is the permission class that is usually auto-allowed, so it stays
   * exactly where it is for everything else.
   *
   * Temp is the exception because it is where the agent's own work goes. The
   * run that prompted this unpacked two npm tarballs into `/tmp` and then had
   * to read them back; `read_file` refused, so it used `cat` piped through
   * `head`, `tail` and `sed` instead, and read one type-definition file ten
   * times in overlapping windows because nothing there tracks what it has
   * already seen. Nothing was gained by refusing: `run_command` had just
   * written those files.
   */
  private resolveForReading(rel: string | undefined): string {
    if (!rel) throw new Error('Missing "path" argument.');
    const resolved = path.resolve(this.root, rel);
    if (resolved === this.root || resolved.startsWith(this.root + path.sep)) return resolved;

    if (tempRoots().some((r) => resolved === r || resolved.startsWith(r + path.sep))) return resolved;

    throw new Error(
      `Path escapes the workspace: ${rel}. Only the workspace and the system temp directory can be read; ` +
        'use run_command for anything else.',
    );
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
      // detached: the shell gets its own process group, so killTree below can
      // signal the whole group rather than just the wrapper (see killTree).
      const child = spawn(wrapped, { shell: true, cwd: this.cwd, env: process.env, detached: trackCwd });
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
            // Relative, and only once the shell has left the root: at the root
            // it is what the description already says, and repeating it on
            // every command would be noise on the common case.
            cwd: this.cwd === this.root ? undefined : path.relative(this.root, this.cwd).replace(/\\/g, '/'),
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

