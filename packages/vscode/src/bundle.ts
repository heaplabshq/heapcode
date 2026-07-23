import * as vscode from 'vscode';
import { discoverSkills } from './agent/skills.js';

const BUNDLE_VERSION = 1;
const DEFAULT_FILENAME = 'heapcode-bundle.json';

/**
 * Workspace-level agent-behavior settings worth sharing with a team — how
 * Plan/Act gating, personas' tool access, and safety gates are configured
 * for this project. Personal/machine tuning (maxIterations, commandTimeout)
 * is intentionally included too: simplest to export everything actually SET
 * at the workspace level (see buildBundle) rather than hand-picking which
 * settings "count" as a team concern.
 */
const AGENT_SETTINGS_KEYS = [
  'enable',
  'planFirst',
  'planGate',
  'maxIterations',
  'disabledTools',
  'safeMode',
  'commandTimeout',
  'memoryDistillation',
  'requireTestsBeforeFinish',
  'subAgents',
];

interface HeapCodeBundle {
  version: number;
  exportedAt: string;
  /** workspace-relative path -> base64 content. */
  files: Record<string, string>;
  agentSettings: Record<string, unknown>;
}

async function readFileBase64(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('base64');
  } catch {
    return undefined;
  }
}

/** Every file under `dir`, recursively, as workspace-relative paths. */
async function listFilesRecursive(dir: vscode.Uri): Promise<string[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const [name, type] of entries) {
    const uri = vscode.Uri.joinPath(dir, name);
    if (type === vscode.FileType.Directory) out.push(...(await listFilesRecursive(uri)));
    else if (type === vscode.FileType.File) out.push(vscode.workspace.asRelativePath(uri, false));
  }
  return out;
}

/**
 * Gathers everything that makes this project's Heap Code setup distinctive
 * and worth sharing (PLAN.md M13): .heapcode/ (instructions, memory),
 * project-level Skills (.claude/skills/ — personal ones at ~/.claude/skills/
 * are deliberately excluded, they're not this project's to share), and
 * workspace-scoped agent settings. No hosted service — a single JSON file.
 */
export async function buildBundle(): Promise<HeapCodeBundle | undefined> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) return undefined;

  const candidatePaths = new Set<string>(['.heapcode/HEAPCODE.md', '.heapcode/memory.md']);
  for (const rel of await listFilesRecursive(vscode.Uri.joinPath(root, '.heapcode', 'instructions'))) {
    candidatePaths.add(rel);
  }
  const projectSkills = (await discoverSkills()).filter((s) => s.source === 'project');
  for (const skill of projectSkills) {
    for (const rel of await listFilesRecursive(skill.dir)) candidatePaths.add(rel);
  }

  const files: Record<string, string> = {};
  for (const rel of candidatePaths) {
    const content = await readFileBase64(vscode.Uri.joinPath(root, rel));
    if (content !== undefined) files[rel] = content;
  }

  const cfg = vscode.workspace.getConfiguration('heapcode.agent');
  const agentSettings: Record<string, unknown> = {};
  for (const key of AGENT_SETTINGS_KEYS) {
    const inspected = cfg.inspect(key);
    // Only settings actually set at the workspace/workspace-folder level —
    // exporting every default would make every bundle identical noise.
    if (inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined) {
      agentSettings[key] = cfg.get(key);
    }
  }

  return { version: BUNDLE_VERSION, exportedAt: new Date().toISOString(), files, agentSettings };
}

export async function exportBundle(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    void vscode.window.showWarningMessage('Heap Code: open a workspace folder first.');
    return;
  }
  const bundle = await buildBundle();
  if (!bundle || (Object.keys(bundle.files).length === 0 && Object.keys(bundle.agentSettings).length === 0)) {
    void vscode.window.showInformationMessage(
      'Heap Code: nothing to export yet — no .heapcode files, project Skills, or workspace-level agent settings found.',
    );
    return;
  }
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.joinPath(root, DEFAULT_FILENAME),
    filters: { 'Heap Code Bundle': ['json'] },
  });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(bundle, null, 2)));
  void vscode.window.showInformationMessage(
    `Heap Code: exported ${Object.keys(bundle.files).length} file(s) and ${Object.keys(bundle.agentSettings).length} setting(s) to ${uri.fsPath}.`,
  );
}

export async function importBundle(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    void vscode.window.showWarningMessage('Heap Code: open a workspace folder first.');
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'Heap Code Bundle': ['json'] },
  });
  if (!picked || picked.length === 0) return;

  let bundle: HeapCodeBundle;
  try {
    const bytes = await vscode.workspace.fs.readFile(picked[0]!);
    bundle = JSON.parse(new TextDecoder().decode(bytes)) as HeapCodeBundle;
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Heap Code: couldn't read that bundle — ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (bundle.version !== BUNDLE_VERSION || typeof bundle.files !== 'object') {
    void vscode.window.showErrorMessage('Heap Code: not a recognized Heap Code bundle file.');
    return;
  }

  const fileCount = Object.keys(bundle.files).length;
  const settingCount = Object.keys(bundle.agentSettings ?? {}).length;
  const confirm = await vscode.window.showWarningMessage(
    `Import this bundle? This will write/overwrite ${fileCount} file(s) (memory, instructions, project skills)` +
      `${settingCount > 0 ? ` and set ${settingCount} agent setting(s)` : ''} in this workspace.`,
    { modal: true },
    'Import',
  );
  if (confirm !== 'Import') return;

  for (const [rel, base64] of Object.entries(bundle.files)) {
    const uri = vscode.Uri.joinPath(root, rel);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(base64, 'base64'));
  }
  if (settingCount > 0) {
    const cfg = vscode.workspace.getConfiguration('heapcode.agent');
    for (const [key, value] of Object.entries(bundle.agentSettings)) {
      await cfg.update(key, value, vscode.ConfigurationTarget.Workspace);
    }
  }
  void vscode.window.showInformationMessage(
    `Heap Code: imported ${fileCount} file(s)${settingCount > 0 ? ` and ${settingCount} setting(s)` : ''}.`,
  );
}
