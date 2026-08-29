import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchPrDiff, parseDiffHunkRanges, splitDiffByFile, retireOnRebuild } from '../src/index.js';

/**
 * Getting the diff at all.
 *
 * `gh pr diff` is the obvious source and it has a hard ceiling: GitHub refuses
 * the `.diff` media type above 20,000 lines. That is not an exotic size, and
 * when it happened the review reported "no changes, or gh failed" -- which
 * sends whoever is debugging it to check their `gh` install for a problem that
 * is not there. It found the PR perfectly well; it could not get the diff.
 *
 * So there are three sources now, and what these cover is the fall-through
 * between them and the shape of what comes out the other end. The reassembled
 * diff has to satisfy `splitDiffByFile` and `parseDiffHunkRanges` -- if it does
 * not, findings still appear but none of them can anchor to a line, which is a
 * far quieter failure than the one this started as.
 */

let dir: string;
let repo: string;
let bin: string;
let originalPath: string | undefined;

const git = (args: string[], cwd: string): string =>
  spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout ?? '';

/** A `gh` on PATH whose two subcommands are scripted per test. */
async function installGh(prDiff: string, filesJson: string[]): Promise<void> {
  const script = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "diff" ]; then
${prDiff}
fi
if [ "$1" = "api" ]; then
  cat <<'FILES_EOF'
${filesJson.join('\n')}
FILES_EOF
  exit 0
fi
exit 1
`;
  await writeFile(join(bin, 'gh'), script, 'utf8');
  await chmod(join(bin, 'gh'), 0o755);
}

/** `gh pr diff` refusing the way GitHub actually refuses an oversized diff. */
const REFUSES_406 = `  echo "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)" >&2
  exit 1`;

const SUCCEEDS = `  cat <<'DIFF_EOF'
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
DIFF_EOF
  exit 0`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'prdiff-'));
  bin = join(dir, 'bin');
  await mkdir(bin);
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;

  // A real repository with a real remote-tracking branch, because the last
  // fallback asks git for `origin/<base>...HEAD` and a fake would prove nothing.
  const upstream = join(dir, 'upstream');
  await mkdir(upstream);
  git(['init', '-q', '--initial-branch=main'], upstream);
  git(['config', 'user.email', 't@example.com'], upstream);
  git(['config', 'user.name', 'T'], upstream);
  await writeFile(join(upstream, 'seed.txt'), 'seed\n', 'utf8');
  git(['add', '.'], upstream);
  git(['commit', '-qm', 'seed'], upstream);

  repo = join(dir, 'repo');
  git(['clone', '-q', upstream, repo], dir);
  git(['config', 'user.email', 't@example.com'], repo);
  git(['config', 'user.name', 'T'], repo);
  git(['checkout', '-qb', 'feature'], repo);
  await mkdir(join(repo, 'deep', 'nested'), { recursive: true });
  await writeFile(join(repo, 'deep', 'nested', 'big.ts'), 'export const x = 1;\n', 'utf8');
  git(['add', '.'], repo);
  git(['commit', '-qm', 'add big'], repo);
});

afterEach(async () => {
  process.env.PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe('the first source: gh pr diff', () => {
  it('is used as-is when GitHub will give it to us', async () => {
    await installGh(SUCCEEDS, []);
    const got = await fetchPrDiff(1, repo, 'main');

    expect(got.diff).toContain('+++ b/src/a.ts');
    expect(got.unreviewable).toEqual([]);
  });
});

describe('when GitHub refuses the diff for being too large', () => {
  it('falls back to the per-file endpoint instead of reporting no changes', async () => {
    await installGh(REFUSES_406, [
      JSON.stringify({
        filename: 'src/a.ts',
        status: 'modified',
        patch: '@@ -1,2 +1,3 @@\n const a = 1;\n+const b = 2;',
      }),
    ]);

    const got = await fetchPrDiff(1, repo, 'main');
    expect(got.diff).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(got.reason).toBeUndefined();
  });

  it('produces a diff the line-anchoring parser accepts', async () => {
    // The quiet failure this guards: a reassembly that reads fine to a human
    // but carries no `+++ b/` or `@@`, so every finding loses its line and the
    // review posts as one undifferentiated comment.
    await installGh(REFUSES_406, [
      JSON.stringify({
        filename: 'src/a.ts',
        status: 'modified',
        patch: '@@ -10,3 +10,4 @@\n keep\n+added\n keep',
      }),
      JSON.stringify({ filename: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1,2 @@\n+one\n+two' }),
    ]);

    const got = await fetchPrDiff(1, repo, 'main');
    const files = splitDiffByFile(got.diff);
    const ranges = parseDiffHunkRanges(got.diff);

    expect(files.map((f) => f.file)).toEqual(['src/a.ts', 'src/new.ts']);
    expect(ranges.get('src/a.ts')).toEqual([[10, 13]]);
    expect(ranges.get('src/new.ts')).toEqual([[1, 2]]);
  });

  it('marks an added file against /dev/null and a removed one the other way', async () => {
    await installGh(REFUSES_406, [
      JSON.stringify({ filename: 'gone.ts', status: 'removed', patch: '@@ -1,2 +0,0 @@\n-one\n-two' }),
      JSON.stringify({ filename: 'fresh.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+new' }),
    ]);

    const got = await fetchPrDiff(1, repo, 'main');
    expect(got.diff).toContain('--- a/gone.ts\n+++ /dev/null');
    expect(got.diff).toContain('--- /dev/null\n+++ b/fresh.ts');
  });

  it('follows a rename to the name the file had before', async () => {
    await installGh(REFUSES_406, [
      JSON.stringify({
        filename: 'after.ts',
        previous_filename: 'before.ts',
        status: 'renamed',
        patch: '@@ -1 +1 @@\n-old\n+new',
      }),
    ]);

    const got = await fetchPrDiff(1, repo, 'main');
    expect(got.diff).toContain('diff --git a/before.ts b/after.ts');
    expect(got.diff).toContain('--- a/before.ts');
    expect(got.diff).toContain('+++ b/after.ts');
  });
});

describe('files the per-file endpoint will not patch either', () => {
  it('recovers a source file from the local checkout', async () => {
    // GitHub does not only omit the patch for binaries. On a large PR it stops
    // computing them partway and returns real source files as `+0/-0 added`
    // with no patch at all -- which reads as an empty change and is not one.
    await installGh(REFUSES_406, [
      JSON.stringify({ filename: 'deep/nested/big.ts', status: 'added' }),
    ]);

    const got = await fetchPrDiff(1, repo, 'main');
    expect(got.unreviewable).toEqual([]);
    expect(got.diff).toContain('deep/nested/big.ts');
    expect(parseDiffHunkRanges(got.diff).has('deep/nested/big.ts')).toBe(true);
  });

  it('recovers it when started below the repository root, not only at it', async () => {
    // The bug this test exists for: `gh` walks up to find the repo, so the
    // first two sources work from a subdirectory. A pathspec does not -- it
    // resolves against the working directory, so `deep/nested/big.ts` asked
    // from `deep/` matches nothing, exits 0 with no output, and the file is
    // reported unreviewable while its diff sits on disk.
    await installGh(REFUSES_406, [
      JSON.stringify({ filename: 'deep/nested/big.ts', status: 'added' }),
    ]);

    const got = await fetchPrDiff(1, join(repo, 'deep'), 'main');
    expect(got.unreviewable).toEqual([]);
    expect(got.diff).toContain('deep/nested/big.ts');
  });

  it('reports the repository root so the caller can warn about the workspace', async () => {
    await installGh(REFUSES_406, [JSON.stringify({ filename: 'deep/nested/big.ts', status: 'added' })]);
    const got = await fetchPrDiff(1, join(repo, 'deep'), 'main');
    expect(got.gitRoot).toBeDefined();
    expect(got.gitRoot).not.toBe(join(repo, 'deep'));
  });

  it('still reports a genuinely unreviewable file rather than passing it over', async () => {
    // A binary has no text diff anywhere, so it stays unreviewable -- named,
    // because a file nobody reviewed must not read as a file with nothing
    // wrong in it.
    await installGh(REFUSES_406, [
      JSON.stringify({ filename: 'assets/icon.png', status: 'added' }),
      JSON.stringify({ filename: 'src/a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }),
    ]);

    const got = await fetchPrDiff(1, repo, 'main');
    expect(got.unreviewable).toEqual(['assets/icon.png']);
    expect(got.diff).toContain('src/a.ts');
  });

  it('does not reach for git at all when no base branch is known', async () => {
    await installGh(REFUSES_406, [JSON.stringify({ filename: 'deep/nested/big.ts', status: 'added' })]);
    const got = await fetchPrDiff(1, repo, undefined);
    expect(got.unreviewable).toEqual(['deep/nested/big.ts']);
  });
});

describe('when nothing can produce a diff', () => {
  it('passes through what gh actually said instead of guessing', async () => {
    // The original message -- "no changes, or gh failed" -- described neither
    // of the two things that had happened.
    await writeFile(
      join(bin, 'gh'),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.0.0"; exit 0; fi
echo "HTTP 403: rate limit exceeded" >&2
exit 1
`,
      'utf8',
    );
    await chmod(join(bin, 'gh'), 0o755);

    const got = await fetchPrDiff(1, repo, 'main');
    expect(got.diff).toBe('');
    expect(got.reason).toContain('rate limit exceeded');
  });

  it('says so plainly when the PR really has no changes', async () => {
    await installGh(`  exit 1`, []);
    const got = await fetchPrDiff(1, repo, 'main');
    expect(got.diff).toBe('');
    expect(got.reason).toBe('it has no changes');
  });
});

describe('a daemon that has been rebuilt underneath itself', () => {
  /**
   * The other half of the same debugging session. The daemon outlives the
   * session that spawned it, so it outlives a rebuild too -- and then serves
   * the old code to every client while the fix sits on disk, with nothing
   * anywhere saying why.
   */
  it('exits once the bundle changes and nothing is using it', async () => {
    const entry = join(dir, 'daemon.js');
    await writeFile(entry, 'v1', 'utf8');

    const logs: string[] = [];
    let exited: number | undefined;
    await retireOnRebuild(
      entry,
      { sessionCount: 0 },
      async (line) => void logs.push(line),
      async (code) => void (exited = code),
      5,
    );

    await new Promise((r) => setTimeout(r, 20));
    await writeFile(entry, 'v2-and-longer', 'utf8');
    await new Promise((r) => setTimeout(r, 80));

    expect(exited).toBe(0);
    expect(logs.join(' ')).toContain('was rebuilt');
  });

  it('waits rather than killing a run that is still going', async () => {
    const entry = join(dir, 'busy.js');
    await writeFile(entry, 'v1', 'utf8');

    const server = { sessionCount: 1 };
    let exited: number | undefined;
    await retireOnRebuild(
      entry,
      server,
      async () => {},
      async (code) => void (exited = code),
      5,
    );

    await new Promise((r) => setTimeout(r, 20));
    await writeFile(entry, 'v2-and-longer', 'utf8');
    await new Promise((r) => setTimeout(r, 60));
    expect(exited).toBeUndefined();

    server.sessionCount = 0;
    await new Promise((r) => setTimeout(r, 60));
    expect(exited).toBe(0);
  });

  it('does nothing at all while the bundle is untouched', async () => {
    const entry = join(dir, 'stable.js');
    await writeFile(entry, 'v1', 'utf8');

    let exited: number | undefined;
    await retireOnRebuild(
      entry,
      { sessionCount: 0 },
      async () => {},
      async (code) => void (exited = code),
      5,
    );
    await new Promise((r) => setTimeout(r, 60));
    expect(exited).toBeUndefined();
  });
});
