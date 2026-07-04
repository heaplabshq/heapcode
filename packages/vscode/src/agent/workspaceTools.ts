import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { applySearchReplace, type ToolCall, type ToolDefinition, type ToolResult } from '@cortex/core';
import type { SessionCheckpoint } from './checkpoint.js';

const MAX_READ_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 2_000;
const IGNORE_GLOB = '**/{node_modules,dist,build,target,.git,coverage,vendor,out,.next}/**';

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
      'Run a shell command in the workspace root (npm/pnpm/git/tests/etc). Returns stdout, stderr, and exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
      },
      required: ['command'],
    },
    permission: 'execute',
  },
];

export class WorkspaceToolExecutor {
  constructor(
    private readonly root: vscode.Uri,
    private readonly checkpoint: SessionCheckpoint,
    private readonly commandTimeoutMs: number,
    private readonly semanticSearch?: (query: string) => Promise<string>,
  ) {}

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
        const next = applySearchReplace(current, a.search ?? '', a.replace ?? '');
        if (next === undefined) {
          return fail(
            `The "search" text was not found in ${a.path}. Read the file again and provide the exact existing code.`,
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
      for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
        if (regex.test(lines[i]!)) {
          results.push(
            `${vscode.workspace.asRelativePath(file, false)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`,
          );
        }
      }
    }
    return results.join('\n') || 'No matches.';
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
    return new Promise((resolvePromise) => {
      const child = spawn(command, {
        shell: true,
        cwd: this.root.fsPath,
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
