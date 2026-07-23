import { spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

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
  '.heapcode/',
];

/**
 * Node-native port of packages/vscode/src/agent/shadowGit.ts — workspace
 * checkpoints via a shadow git repository (a separate git-dir whose
 * work-tree is the project root; the user's own .git is untouched). Was
 * already almost entirely plain node:child_process — only vscode.Uri/
 * vscode.workspace.fs/vscode.OutputChannel needed swapping for plain
 * strings, fs/promises, and a callback logger.
 */
export class ShadowGit {
  private ready?: Promise<boolean>;

  constructor(
    private readonly workspaceRoot: string,
    private readonly gitDir: string,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Lazily initialize the shadow repo; false when git is unavailable. */
  ensure(): Promise<boolean> {
    this.ready ??= this.init();
    return this.ready;
  }

  /**
   * DEFAULT_EXCLUDES plus, when gitDir itself sits inside workspaceRoot, its
   * own relative path — self-protecting against the shadow repo recursively
   * tracking its own growing object database (a real bug this caught in
   * testing: a gitDir not already covered by one of the standard excludes
   * turns `git add -A` into tracking thousands of its own object files,
   * corrupting every diff/restore). Callers should still nest gitDir under
   * an already-excluded directory (e.g. .heapcode/) — this is a backstop,
   * not a reason to skip that.
   */
  private excludeList(): string[] {
    const rel = relative(this.workspaceRoot, this.gitDir).split('\\').join('/');
    const isInside = rel && !rel.startsWith('..') && rel !== '.';
    return isInside ? [...DEFAULT_EXCLUDES, `/${rel}/`] : DEFAULT_EXCLUDES;
  }

  private async init(): Promise<boolean> {
    try {
      await this.git(['--version'], { bare: true });
      try {
        await stat(join(this.gitDir, 'HEAD'));
      } catch {
        await mkdir(this.gitDir, { recursive: true });
        await this.git(['init', '--bare', this.gitDir], { bare: true });
        await this.git(['config', 'core.bare', 'false']);
        await this.git(['config', 'core.worktree', this.workspaceRoot]);
        await this.git(['config', 'user.name', 'Heap Code']);
        await this.git(['config', 'user.email', 'heapcode@localhost']);
        await this.git(['config', 'commit.gpgsign', 'false']);
        await mkdir(join(this.gitDir, 'info'), { recursive: true });
        await writeFile(join(this.gitDir, 'info', 'exclude'), this.excludeList().join('\n') + '\n');
      }
      return true;
    } catch (err) {
      this.log(`[checkpoint] shadow git unavailable: ${err instanceof Error ? err.message : err}`);
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
      this.log(`[checkpoint] snapshot ${hash.slice(0, 8)}: ${label.slice(0, 80)}`);
      return hash;
    } catch (err) {
      this.log(`[checkpoint] snapshot failed: ${err instanceof Error ? err.message : err}`);
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
        await rm(join(this.workspaceRoot, rel), { force: true });
      }
      await this.git(['add', '-A']);
      await this.git(['commit', '--allow-empty', '--no-verify', '-m', `restored to ${hash.slice(0, 8)}`]);
      this.log(`[checkpoint] restored to ${hash.slice(0, 8)} (${toCheckout.length + toDelete.length} files)`);
      return [...toCheckout, ...toDelete];
    } catch (err) {
      this.log(`[checkpoint] restore failed: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  }

  /**
   * Recent checkpoints, most recent first — read straight from the shadow
   * repo's own commit log rather than any in-memory transcript state, so
   * checkpoints stay listable/rewindable across /new, /resume, or a whole
   * new process (real usage gap found in CLI-M1's version: an in-memory-only
   * checkpoint list went blind the moment the transcript was cleared, even
   * though the underlying git history — and therefore the actual ability to
   * rewind — was still fully intact).
   */
  async history(limit = 50): Promise<Array<{ hash: string; label: string; date: number }>> {
    if (!(await this.ensure())) return [];
    try {
      const out = await this.git(['log', `-n${limit}`, '--format=%H%x1f%ct%x1f%s']);
      return out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, ts, label] = line.split('\x1f');
          return { hash: hash!, label: label ?? '', date: Number(ts) * 1000 };
        });
    } catch {
      return [];
    }
  }

  private git(args: string[], opts: { bare?: boolean } = {}): Promise<string> {
    const fullArgs = opts.bare ? args : ['--git-dir', this.gitDir, '--work-tree', this.workspaceRoot, ...args];
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
