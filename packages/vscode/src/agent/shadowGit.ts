import { spawn } from 'node:child_process';
import * as vscode from 'vscode';

const GIT_TIMEOUT_MS = 120_000;
/** Never snapshot these even when the workspace has no .gitignore. */
const DEFAULT_EXCLUDES = [
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'target/',
  'coverage/',
  'vendor/',
  '.next/',
  '.cortex/',
  '*.vsix',
];

/**
 * Workspace checkpoints via a shadow git repository: a separate git-dir in
 * extension storage whose work-tree is the workspace root. The user's own
 * .git is untouched. Powers "edit an earlier prompt and restore the code to
 * that point" — byte-level per-file checkpoints can't restore across turns.
 */
export class ShadowGit {
  private ready?: Promise<boolean>;

  constructor(
    private readonly workspaceRoot: string,
    private readonly gitDir: vscode.Uri,
    private readonly log: vscode.OutputChannel,
  ) {}

  /** Lazily initialize the shadow repo; false when git is unavailable. */
  ensure(): Promise<boolean> {
    this.ready ??= this.init();
    return this.ready;
  }

  private async init(): Promise<boolean> {
    try {
      await this.git(['--version'], { bare: true });
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.gitDir, 'HEAD'));
      } catch {
        await vscode.workspace.fs.createDirectory(this.gitDir);
        await this.git(['init', '--bare', this.gitDir.fsPath], { bare: true });
        await this.git(['config', 'core.bare', 'false']);
        await this.git(['config', 'core.worktree', this.workspaceRoot]);
        await this.git(['config', 'user.name', 'Cortex']);
        await this.git(['config', 'user.email', 'cortex@localhost']);
        await this.git(['config', 'commit.gpgsign', 'false']);
        await vscode.workspace.fs.writeFile(
          vscode.Uri.joinPath(this.gitDir, 'info', 'exclude'),
          new TextEncoder().encode(DEFAULT_EXCLUDES.join('\n') + '\n'),
        );
      }
      return true;
    } catch (err) {
      this.log.appendLine(
        `[checkpoint] shadow git unavailable: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  /** Commit the current workspace state; returns the commit hash. */
  async snapshot(label: string): Promise<string | undefined> {
    if (!(await this.ensure())) return undefined;
    try {
      await this.git(['add', '-A']);
      await this.git(['commit', '--allow-empty', '--no-verify', '-m', label.slice(0, 200)]);
      const hash = (await this.git(['rev-parse', 'HEAD'])).trim();
      this.log.appendLine(`[checkpoint] snapshot ${hash.slice(0, 8)}: ${label.slice(0, 80)}`);
      return hash;
    } catch (err) {
      this.log.appendLine(
        `[checkpoint] snapshot failed: ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  /**
   * Restore the workspace to a snapshot. The pre-restore state is committed
   * first, so a restore is itself always undoable. Returns the restored
   * (changed/deleted) workspace-relative paths.
   */
  async restore(hash: string): Promise<string[] | undefined> {
    if (!(await this.ensure())) return undefined;
    try {
      await this.git(['add', '-A']);
      await this.git(['commit', '--allow-empty', '--no-verify', '-m', `pre-restore state`]);

      // Diff snapshot → now: A = created since (delete), M/D = checkout from snapshot.
      const diff = (await this.git(['diff', '--name-status', hash, 'HEAD'])).trim();
      if (!diff) return [];
      const toDelete: string[] = [];
      const toCheckout: string[] = [];
      for (const line of diff.split('\n')) {
        const [status, ...rest] = line.split('\t');
        const p = rest[rest.length - 1];
        if (!status || !p) continue;
        if (status.startsWith('A')) toDelete.push(p);
        else toCheckout.push(p);
      }
      if (toCheckout.length > 0) await this.git(['checkout', hash, '--', ...toCheckout]);
      for (const rel of toDelete) {
        try {
          await vscode.workspace.fs.delete(
            vscode.Uri.joinPath(vscode.Uri.file(this.workspaceRoot), rel),
            { useTrash: true },
          );
        } catch {
          // already gone
        }
      }
      await this.git(['add', '-A']);
      await this.git(['commit', '--allow-empty', '--no-verify', '-m', `restored to ${hash.slice(0, 8)}`]);
      this.log.appendLine(
        `[checkpoint] restored to ${hash.slice(0, 8)} (${toCheckout.length + toDelete.length} files)`,
      );
      return [...toCheckout, ...toDelete];
    } catch (err) {
      this.log.appendLine(
        `[checkpoint] restore failed: ${err instanceof Error ? err.message : err}`,
      );
      return undefined;
    }
  }

  private git(args: string[], opts: { bare?: boolean } = {}): Promise<string> {
    const fullArgs = opts.bare
      ? args
      : ['--git-dir', this.gitDir.fsPath, '--work-tree', this.workspaceRoot, ...args];
    return new Promise((resolve, reject) => {
      const child = spawn('git', fullArgs, { cwd: this.workspaceRoot, env: process.env });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      child.stderr.on('data', (c: Buffer) => (err += c.toString()));
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`git ${args[0]} timed out`));
      }, GIT_TIMEOUT_MS);
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve(out);
        else reject(new Error(`git ${args.join(' ').slice(0, 120)} → exit ${code}: ${err.slice(0, 400)}`));
      });
      child.on('error', (e) => {
        clearTimeout(timeout);
        reject(e);
      });
    });
  }
}
