import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  applySearchReplace,
  findBestMatch,
  type ToolCall,
  type ToolDefinition,
  type ToolResult,
} from '@heapcode/core';
import type { SessionCheckpoint } from './checkpoint.js';

const MAX_READ_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_SEARCH_RESULTS = 40;
const MAX_SEARCH_FILES = 2_000;
const MAX_FETCH_CHARS = 20_000;
const IGNORE_GLOB = '**/{node_modules,dist,build,target,.git,coverage,vendor,out,.next}/**';
const CWD_MARKER = '__HEAPCODE_CWD__';

export const agentToolDefinitions: ToolDefinition[] = [
  {
    name: 'read_file',
    description:
      'Read a file (or a line range of it). Returns content with line numbers.',
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
    name: 'get_diagnostics',
    description: 'Get current errors/warnings from the IDE (optionally for one file).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Optional workspace-relative path' } },
    },
    permission: 'read',
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
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
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
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
    name: 'run_command',
    description:
      'Run a shell command (npm/pnpm/git/tests/etc). Returns stdout, stderr, and exit code. ' +
      'The working directory persists between calls (cd carries over); it starts at the workspace root.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
    permission: 'execute',
  },
  {
    name: 'get_symbols',
    description:
      'Outline of a file from the language server: functions, classes, methods with their line ranges. Much cheaper than reading the whole file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative path' } },
      required: ['path'],
    },
    permission: 'read',
  },
  {
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
  },
  {
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
  },
  {
    name: 'fetch_url',
    description:
      'Fetch a web page or API over HTTP(S) — documentation, READMEs, API responses. HTML is reduced to readable text.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s):// URL' } },
      required: ['url'],
    },
    permission: 'execute',
  },
  {
    name: 'multi_edit',
    description:
      'Apply several search/replace edits to one file atomically (all succeed or none are written). Same matching rules as edit_file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              search: { type: 'string', description: 'Existing code to replace' },
              replace: { type: 'string', description: 'New code' },
            },
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
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    permission: 'write',
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a clarifying question when blocked on a decision only they can make (ambiguous requirements, destructive trade-offs). Use sparingly — prefer sensible defaults.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional short answer choices',
        },
      },
      required: ['question'],
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

export class WorkspaceToolExecutor {
  /** run_command working directory — persists across calls within a session. */
  private cwd: string;

  constructor(
    private readonly root: vscode.Uri,
    private readonly checkpoint: SessionCheckpoint,
    private readonly commandTimeoutMs: number,
    private readonly semanticSearch?: (query: string) => Promise<string>,
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
      case 'get_symbols':
        return `Outline ${a.path}`;
      case 'find_references':
        return `Find references to ${a.symbol} (from ${a.path})`;
      case 'go_to_definition':
        return `Find definition of ${a.symbol} (from ${a.path})`;
      case 'fetch_url':
        return `Fetch ${a.url}`;
      case 'multi_edit': {
        const count = Array.isArray(call.args.edits) ? call.args.edits.length : 0;
        return `Edit ${a.path} (${count} edits)`;
      }
      case 'create_directory':
        return `Create directory ${a.path}`;
      case 'ask_user':
        return `Ask: ${String(a.question ?? '').slice(0, 80)}`;
      default:
        return `${call.name} ${JSON.stringify(call.args)}`;
    }
  }

  async execute(call: ToolCall): Promise<ToolResult> {
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
        await this.checkpoint.recordBeforeChange(uri);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(a.content ?? ''));
        return ok(`Wrote ${a.path}.`);
      }
      case 'edit_file': {
        const uri = this.resolve(a.path);
        const current = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        const next = applySearchReplace(current, String(a.search ?? ''), String(a.replace ?? ''));
        if (next === undefined) {
          return fail(
            `The "search" text was not found in ${a.path}. ${nearbyHint(current, String(a.search ?? ''))}` +
              'Provide the exact existing code (copy it from read_file output, without the line numbers).',
          );
        }
        await this.checkpoint.recordBeforeChange(uri);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
        return ok(`Edited ${a.path}.`);
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
      case 'run_command':
        return this.runCommand(a.command ?? '');
      case 'get_symbols': {
        const uri = this.resolve(a.path);
        const symbols = await vscode.commands.executeCommand<
          (vscode.DocumentSymbol | vscode.SymbolInformation)[]
        >('vscode.executeDocumentSymbolProvider', uri);
        if (!symbols || symbols.length === 0) {
          return ok('No symbols found (no language server for this file type, or an empty file).');
        }
        return ok(formatSymbols(symbols).join('\n'));
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
      case 'multi_edit': {
        const uri = this.resolve(a.path);
        const edits = Array.isArray(call.args.edits)
          ? (call.args.edits as Array<{ search?: unknown; replace?: unknown }>)
          : [];
        if (edits.length === 0) return fail('No edits given.');
        let text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        // Apply all in memory first — nothing is written unless every edit lands.
        for (let i = 0; i < edits.length; i++) {
          const next = applySearchReplace(text, String(edits[i]!.search ?? ''), String(edits[i]!.replace ?? ''));
          if (next === undefined) {
            return fail(
              `Edit ${i + 1}/${edits.length}: "search" not found in ${a.path} (earlier edits were NOT applied). ` +
                `${nearbyHint(text, String(edits[i]!.search ?? ''))}` +
                'Provide the exact existing code for each edit.',
            );
          }
          text = next;
        }
        await this.checkpoint.recordBeforeChange(uri);
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
        return ok(`Applied ${edits.length} edits to ${a.path}.`);
      }
      case 'create_directory': {
        await vscode.workspace.fs.createDirectory(this.resolve(a.path));
        return ok(`Created ${a.path}.`);
      }
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
    const files = await vscode.workspace.findFiles(glob || '**/*', IGNORE_GLOB, MAX_SEARCH_FILES);
    const results: string[] = [];
    for (const file of files) {
      if (results.length >= MAX_SEARCH_RESULTS) break;
      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        if (bytes.byteLength > 1_000_000) continue;
        text = new TextDecoder().decode(bytes);
        if (text.includes(' ')) continue; // binary
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

  private runCommand(command: string): Promise<ToolResult> {
    if (!command) {
      return Promise.resolve({
        id: '',
        name: 'run_command',
        content: 'Missing "command" argument.',
        isError: true,
      });
    }
    // POSIX: echo the final $PWD behind a marker so `cd` persists to the next call.
    const trackCwd = process.platform !== 'win32';
    const wrapped = trackCwd ? `${command}\n__heapcode_ec=$?; echo "${CWD_MARKER}$PWD"; exit $__heapcode_ec` : command;
    return new Promise((resolvePromise) => {
      const child = spawn(wrapped, {
        shell: true,
        cwd: this.cwd,
        env: process.env,
      });
      let out = '';
      const collect = (chunk: Buffer) => {
        out += chunk.toString();
        if (out.length > MAX_OUTPUT_CHARS * 4) {
          out = out.slice(0, MAX_OUTPUT_CHARS * 2) + '\n…\n' + out.slice(-MAX_OUTPUT_CHARS);
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        out += `\n[killed after ${this.commandTimeoutMs / 1000}s timeout]`;
      }, this.commandTimeoutMs);

      child.on('close', (code) => {
        clearTimeout(timeout);
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
        let content = out.trim() || '(no output)';
        if (content.length > MAX_OUTPUT_CHARS) {
          content =
            content.slice(0, MAX_OUTPUT_CHARS / 2) +
            '\n…[output truncated]…\n' +
            content.slice(-MAX_OUTPUT_CHARS / 2);
        }
        resolvePromise({
          id: '',
          name: 'run_command',
          content: `exit code: ${code ?? 'unknown'}\n${content}`,
          isError: code !== 0,
        });
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        resolvePromise({ id: '', name: 'run_command', content: err.message, isError: true });
      });
    });
  }
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
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timed out fetching ${url}`);
    }
    throw err instanceof Error ? err : new Error(String(err));
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
