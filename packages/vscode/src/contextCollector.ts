import * as vscode from 'vscode';
import { DEFAULT_IGNORE_GLOB, type ContextBlock } from '@heapcode/core';
import { filterIgnored } from './ignoreFiles.js';

const MAX_FILE_CHARS = 60_000;
/** Caps for inlining an attached folder's contents. */
const FOLDER_MAX_FILES_INLINED = 12;
const FOLDER_MAX_CHARS_PER_FILE = 8_000;
const FOLDER_MAX_TOTAL_CHARS = 48_000;

function workspaceRelative(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

/**
 * window.activeTextEditor is undefined while focus sits in a webview (i.e.
 * whenever the user is typing in the chat) — track the last real editor so
 * @file/@selection and Apply/Insert keep working from the chat.
 */
let lastActiveEditor: vscode.TextEditor | undefined;

/**
 * `onClear` fires when the last real editor tab genuinely closes — not on
 * ordinary focus-loss to a webview. `onDidChangeActiveTextEditor` alone
 * can't detect that case: activeTextEditor is already undefined while chat
 * has focus, so closing the last tab from there is an undefined→undefined
 * transition and never fires that event.
 *
 * Uses tabGroups.onDidChangeTabs (the same reliable pattern inlineEdit.ts
 * already uses to detect a closed diff tab) rather than
 * onDidCloseTextDocument + visibleTextEditors — the latter isn't guaranteed
 * to have settled by the time the close event fires.
 */
export function trackActiveEditor(onClear?: () => void): vscode.Disposable {
  lastActiveEditor = vscode.window.activeTextEditor;
  const changeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && (editor.document.uri.scheme === 'file' || editor.document.uri.scheme === 'untitled')) {
      lastActiveEditor = editor;
    }
  });
  const tabListener = vscode.window.tabGroups.onDidChangeTabs((e) => {
    if (e.closed.length === 0 || !lastActiveEditor) return;
    const stillOpen = vscode.window.tabGroups.all.some((group) =>
      group.tabs.some((tab) => {
        const input = tab.input;
        return input instanceof vscode.TabInputText && (input.uri.scheme === 'file' || input.uri.scheme === 'untitled');
      }),
    );
    if (!stillOpen) {
      lastActiveEditor = undefined;
      onClear?.();
    }
  });
  return vscode.Disposable.from(changeListener, tabListener);
}

export function getActiveEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active) return active;
  if (lastActiveEditor && !lastActiveEditor.document.isClosed) return lastActiveEditor;
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file');
}

// ---- terminal awareness (@terminal) ----

const TERMINAL_MAX_RUNS = 5;
const TERMINAL_MAX_RUN_CHARS = 8_000;
const TERMINAL_MAX_TOTAL_CHARS = 16_000;

interface TerminalRun {
  command: string;
  output: string;
}

const terminalRuns: TerminalRun[] = [];

/** Strip ANSI escape/OSC sequences and stray control chars for the model. */
function stripAnsi(text: string): string {
  return (
    text
       
      .replace(/\x1B\][^]*?(?:\x07|\x1B\\)/g, '') // OSC (titles, hyperlinks)
       
      .replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '') // CSI (colors, cursor)
       
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
  );
}

/**
 * Record recent terminal commands + output via shell integration, for the
 * @terminal mention. Terminals without shell integration produce nothing.
 */
export function trackTerminal(): vscode.Disposable {
  return vscode.window.onDidStartTerminalShellExecution(async (event) => {
    let output = '';
    try {
      for await (const data of event.execution.read()) {
        output += data;
        if (output.length > TERMINAL_MAX_RUN_CHARS * 4) break; // runaway output
      }
    } catch {
      // stream ended abnormally — keep what we have
    }
    terminalRuns.push({
      command: event.execution.commandLine.value,
      output: stripAnsi(output).trim().slice(-TERMINAL_MAX_RUN_CHARS),
    });
    if (terminalRuns.length > TERMINAL_MAX_RUNS) terminalRuns.shift();
  });
}

export function collectTerminal(): ContextBlock | undefined {
  if (terminalRuns.length === 0) return undefined;
  const content = terminalRuns
    .map((r) => `$ ${r.command}\n${r.output || '(no output)'}`)
    .join('\n\n')
    .slice(-TERMINAL_MAX_TOTAL_CHARS);
  return { label: 'Recent terminal output', content, priority: 1.5, trust: 'untrusted' };
}

export function collectSelection(): ContextBlock | undefined {
  const editor = getActiveEditor();
  if (!editor || editor.selection.isEmpty) return undefined;
  const text = editor.document.getText(editor.selection);
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  return {
    label: `Selection (${workspaceRelative(editor.document.uri)}:${start}-${end})`,
    content: text,
    priority: 1,
    trust: 'untrusted',
  };
}

export function collectActiveFile(): ContextBlock | undefined {
  const editor = getActiveEditor();
  if (!editor) return undefined;
  let content = editor.document.getText();
  if (content.length > MAX_FILE_CHARS) content = content.slice(0, MAX_FILE_CHARS);
  return {
    label: `File (${workspaceRelative(editor.document.uri)})`,
    content,
    priority: 2,
    trust: 'untrusted',
  };
}

export async function collectFolder(): Promise<ContextBlock | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const found = await vscode.workspace.findFiles('**/*', DEFAULT_IGNORE_GLOB, 500);
  const files = await filterIgnored(folder.uri, found);
  const listing = files
    .map((f) => workspaceRelative(f))
    .sort()
    .join('\n');
  return { label: `Workspace files (${folder.name})`, content: listing, priority: 4, trust: 'untrusted' };
}

export function collectProblems(): ContextBlock | undefined {
  const all = vscode.languages.getDiagnostics();
  const lines: string[] = [];
  for (const [uri, diagnostics] of all) {
    for (const d of diagnostics) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
      const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
      lines.push(`${workspaceRelative(uri)}:${d.range.start.line + 1} [${sev}] ${d.message}`);
      if (lines.length >= 100) break;
    }
    if (lines.length >= 100) break;
  }
  if (lines.length === 0) return undefined;
  return { label: 'Problems (diagnostics)', content: lines.join('\n'), priority: 3, trust: 'untrusted' };
}

/** Attachments ending in "/" are folders (set by the picker / drag-and-drop). */
export function isFolderAttachment(rel: string): boolean {
  return rel.endsWith('/');
}

/** Recursively list files under a workspace-relative folder, nested children included. */
export async function listFolderFiles(rel: string, max = 400): Promise<string[]> {
  const root = vscode.workspace.workspaceFolders?.[0];
  if (!root) return [];
  const base = rel.replace(/\/+$/, '');
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, base ? `${base}/**/*` : '**/*'),
    DEFAULT_IGNORE_GLOB,
    max,
  );
  const files = await filterIgnored(root.uri, found);
  return files.map((f) => workspaceRelative(f)).sort();
}

/**
 * Context blocks for an attached folder: the full recursive listing plus the
 * contents of the first files inlined (small caps — assembleContext enforces
 * the overall budget and reports anything dropped).
 */
export async function collectAttachedFolder(rel: string): Promise<ContextBlock[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const paths = await listFolderFiles(rel);
  if (!root || paths.length === 0) return [];

  const blocks: ContextBlock[] = [
    {
      label: `Attached folder (${rel}) — all ${paths.length} files, nested included`,
      content: paths.join('\n'),
      priority: 2.5,
      trust: 'untrusted',
    },
  ];
  let total = 0;
  let inlined = 0;
  for (const p of paths) {
    if (inlined >= FOLDER_MAX_FILES_INLINED || total >= FOLDER_MAX_TOTAL_CHARS) break;
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, p));
      if (bytes.byteLength > 200_000) continue;
      const text = new TextDecoder().decode(bytes);
      if (text.includes('\0')) continue; // binary
      const content = text.slice(0, FOLDER_MAX_CHARS_PER_FILE);
      blocks.push({ label: `Attached file (${p})`, content, priority: 2.6, trust: 'untrusted' });
      total += content.length;
      inlined++;
    } catch {
      // unreadable — the listing still mentions it
    }
  }
  return blocks;
}

export interface MentionResult {
  blocks: ContextBlock[];
  unresolved: string[];
}

/** Resolve @mentions in a chat message into context blocks. */
export async function resolveMentions(
  text: string,
  retrieve?: (query: string) => Promise<string>,
): Promise<MentionResult> {
  const mentioned = new Set([...text.matchAll(/@(\w+)/g)].map((m) => m[1]!.toLowerCase()));
  const blocks: ContextBlock[] = [];
  const unresolved: string[] = [];

  const push = (block: ContextBlock | undefined, name: string) => {
    if (block) blocks.push(block);
    else unresolved.push(`@${name}`);
  };

  if (mentioned.has('selection')) push(collectSelection(), 'selection');
  if (mentioned.has('file')) push(collectActiveFile(), 'file');
  if (mentioned.has('problems')) push(collectProblems(), 'problems');
  if (mentioned.has('terminal')) push(collectTerminal(), 'terminal');
  if (mentioned.has('folder') || mentioned.has('workspace')) {
    // Semantic retrieval when an index exists; else the file listing.
    const retrieved = retrieve ? await retrieve(text) : '';
    if (retrieved) {
      blocks.push({
        label: 'Relevant code (semantic search)',
        content: retrieved,
        priority: 2,
        trust: 'untrusted',
      });
    } else {
      push(await collectFolder(), 'folder');
    }
  }

  return { blocks, unresolved };
}
