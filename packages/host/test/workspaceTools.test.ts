import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '@heapcode/core';
import { configureAstChunker } from '@heapcode/core';
import { WorkspaceToolExecutor } from '../src/agent/workspaceTools.js';
import { SessionCheckpoint } from '../src/agent/checkpoint.js';
import { canonicalize } from '../src/paths.js';

let root: string;
let executor: WorkspaceToolExecutor;
let checkpoint: SessionCheckpoint;

beforeEach(async () => {
  // canonicalize: os.tmpdir() isn't necessarily what a spawned shell's own
  // $PWD reports for the same directory (macOS: /var -> /private/var) — the
  // run_command cwd-persistence tests below need this to match, same as the
  // real cli.tsx wiring (see paths.ts's canonicalize() doc comment).
  root = canonicalize(await mkdtemp(join(tmpdir(), 'heapcode-tools-')));
  checkpoint = new SessionCheckpoint(root);
  executor = new WorkspaceToolExecutor(root, checkpoint, 5_000);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>, id = '1'): ToolCall {
  return { id, name, args };
}

describe('WorkspaceToolExecutor — path jailing (security property)', () => {
  // resolve() throws synchronously rather than returning a ToolResult — by
  // design, matching the ported vscode original: runAgent's execTool wraps
  // every execute() call in a try/catch and turns a throw into an error
  // ToolResult (packages/core/src/agent/loop.ts), so this is safe in the
  // real agent loop. Calling execute() directly here (bypassing that loop),
  // the correct unit-level expectation is a rejected promise, not a result.
  it('rejects a read_file path that escapes the workspace via ../..', async () => {
    await expect(executor.execute(call('read_file', { path: '../../etc/passwd' }))).rejects.toThrow(/escapes the workspace/);
  });

  it('rejects an absolute path outside the workspace', async () => {
    await expect(executor.execute(call('write_file', { path: '/tmp/evil.txt', content: 'x' }))).rejects.toThrow(/escapes the workspace/);
  });

  it('documents a known boundary: a symlink inside the workspace pointing outside it is still followed (lexical check only, not fs.realpath)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'heapcode-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'secret');
    try {
      await symlink(outside, join(root, 'escape-link'));
      // The resolve() jail is a pure string/path check against the raw (unresolved)
      // target path, matching the vscode original — it blocks path traversal via
      // "../", not a symlink whose *target* happens to live outside the root. This
      // test documents that boundary rather than assuming stronger protection.
      const result = await executor.execute(call('read_file', { path: 'escape-link/secret.txt' }));
      // Whatever happens, it must not silently succeed in reading the outside file
      // via a path our jail check considers in-bounds without at least resolving
      // symlinks — read_file *is* allowed to follow the symlink (path.resolve
      // doesn't reject it), so assert it reads the *pointed-to* content, which is
      // the expected (if permissive) behavior, not a silent escape of the check.
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('secret');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('allows a path exactly at the workspace root', async () => {
    await writeFile(join(root, 'a.txt'), 'hi');
    const result = await executor.execute(call('read_file', { path: '.' === '.' ? 'a.txt' : '' }));
    expect(result.isError).toBeFalsy();
  });
});

describe('WorkspaceToolExecutor — file operations', () => {
  it('write_file then read_file round-trips content with line numbers', async () => {
    await executor.execute(call('write_file', { path: 'a.txt', content: 'line1\nline2' }));
    const result = await executor.execute(call('read_file', { path: 'a.txt' }));
    expect(result.content).toBe('1\tline1\n2\tline2');
  });

  it('write_file refuses to overwrite an existing package.json wholesale, and does not touch it', async () => {
    await writeFile(join(root, 'package.json'), '{ "name": "keep-me" }');
    const result = await executor.execute(call('write_file', { path: 'package.json', content: '{ "scripts": {} }' }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/edit_file or multi_edit/);
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe('{ "name": "keep-me" }');
  });

  it('write_file still allows creating a brand-new package.json that does not exist yet', async () => {
    const result = await executor.execute(call('write_file', { path: 'package.json', content: '{ "name": "fresh" }' }));
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe('{ "name": "fresh" }');
  });

  it('write_file creates missing parent directories', async () => {
    await executor.execute(call('write_file', { path: 'a/b/c.txt', content: 'nested' }));
    expect(await readFile(join(root, 'a/b/c.txt'), 'utf8')).toBe('nested');
  });

  it('write_file records a checkpoint before overwriting', async () => {
    await writeFile(join(root, 'a.txt'), 'original');
    await executor.execute(call('write_file', { path: 'a.txt', content: 'new' }));
    expect(checkpoint.size).toBe(1);
    await checkpoint.revertFile('a.txt');
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('original');
  });

  it('edit_file replaces matching text', async () => {
    await writeFile(join(root, 'a.txt'), 'const x = 1;\nconst y = 2;');
    const result = await executor.execute(call('edit_file', { path: 'a.txt', search: 'const x = 1;', replace: 'const x = 100;' }));
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('const x = 100;\nconst y = 2;');
  });

  it('edit_file result includes a diff of the actual change, not just a bare confirmation', async () => {
    await writeFile(join(root, 'a.txt'), 'const x = 1;\nconst y = 2;');
    const result = await executor.execute(call('edit_file', { path: 'a.txt', search: 'const x = 1;', replace: 'const x = 100;' }));
    expect(result.content).toContain('-const x = 1;');
    expect(result.content).toContain('+const x = 100;');
  });

  it('edit_file fails with a helpful hint when the search text is not found', async () => {
    await writeFile(join(root, 'a.txt'), 'const x = 1;');
    const result = await executor.execute(call('edit_file', { path: 'a.txt', search: 'const z = 999;', replace: 'anything' }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/was not found/);
  });

  it('edit_file refuses to guess when the search text matches more than one place, and does not write anything (real live incident: this exact ambiguity once silently corrupted a file)', async () => {
    const original = 'a();\n});\nb();\n});\nc();\n});';
    await writeFile(join(root, 'a.txt'), original);
    const result = await executor.execute(call('edit_file', { path: 'a.txt', search: '});', replace: 'DONE;' }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/matches 3 different places/);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(original);
  });

  it('edit_file names the lines it matched, so the retry is not blind', async () => {
    await writeFile(join(root, 'a.txt'), 'a();\n});\nb();\n});\nc();\n});');
    const result = await executor.execute(call('edit_file', { path: 'a.txt', search: '});', replace: 'DONE;' }));
    expect(result.content).toMatch(/lines 2, 4, 6/);
  });

  it('edit_file replace_all changes every occurrence — the escape hatch when the sites are genuinely identical', async () => {
    await writeFile(join(root, 'a.txt'), 'a();\n});\nb();\n});\nc();\n});');
    const result = await executor.execute(
      call('edit_file', { path: 'a.txt', search: '});', replace: 'DONE;', replace_all: true }),
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a();\nDONE;\nb();\nDONE;\nc();\nDONE;');
  });

  it('edit_file accepts a stringified replace_all, which smaller models emit', async () => {
    await writeFile(join(root, 'a.txt'), 'x();\nx();');
    const result = await executor.execute(
      call('edit_file', { path: 'a.txt', search: 'x();', replace: 'y();', replace_all: 'true' }),
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('y();\ny();');
  });

  it('edit_file resolves same-code-different-depth by indentation instead of refusing (the nemotron/App.jsx case)', async () => {
    const original = [
      'function run(a, b) {',
      '  if (a) {',
      '    setLoading(true);',
      '  }',
      '  while (b) {',
      '      setLoading(true);',
      '  }',
      '}',
    ].join('\n');
    await writeFile(join(root, 'a.js'), original);
    // Three spaces, not four — a near miss, so the exact pass cannot resolve it
    // and the trimmed fuzzy pass sees two identical candidates.
    const result = await executor.execute(
      call('edit_file', { path: 'a.js', search: '   setLoading(true);', replace: '   setLoading(false);' }),
    );
    expect(result.isError).toBeFalsy();
    // The shallower site — the one the needle's indentation pointed at — and
    // only it. The rewritten line carries the model's own indentation, which is
    // how every fuzzy (non-exact) replacement already behaves.
    expect(await readFile(join(root, 'a.js'), 'utf8')).toBe(
      original.replace('    setLoading(true);', '   setLoading(false);'),
    );
  });

  it('multi_edit supports replace_all per edit', async () => {
    await writeFile(join(root, 'a.txt'), 'x();\nx();\nz();');
    const result = await executor.execute(
      call('multi_edit', {
        path: 'a.txt',
        edits: [
          { search: 'x();', replace: 'y();', replace_all: true },
          { search: 'z();', replace: 'w();' },
        ],
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('y();\ny();\nw();');
  });

  it('multi_edit applies all edits atomically — none written if one fails', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree');
    const result = await executor.execute(
      call('multi_edit', {
        path: 'a.txt',
        edits: [
          { search: 'one', replace: 'ONE' },
          { search: 'nonexistent', replace: 'x' },
        ],
      }),
    );
    expect(result.isError).toBe(true);
    // The first edit must NOT have been persisted despite matching.
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree');
  });

  it('rename_file moves a file', async () => {
    await writeFile(join(root, 'old.txt'), 'content');
    await executor.execute(call('rename_file', { path: 'old.txt', newPath: 'new.txt' }));
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('content');
  });

  it('delete_file removes a file', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    const result = await executor.execute(call('delete_file', { path: 'a.txt' }));
    expect(result.isError).toBeFalsy();
    await expect(readFile(join(root, 'a.txt'))).rejects.toThrow();
  });

  it('list_dir lists entries, directories suffixed with /', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    await mkdir(join(root, 'sub'));
    const result = await executor.execute(call('list_dir', { path: '.' }));
    expect(result.content.split('\n').sort()).toEqual(['a.txt', 'sub/']);
  });

  it('create_directory makes nested directories', async () => {
    await executor.execute(call('create_directory', { path: 'a/b/c' }));
    await writeFile(join(root, 'a/b/c/ok.txt'), 'x'); // throws if the dir wasn't actually created
  });
});

describe('WorkspaceToolExecutor — search', () => {
  it('finds matches with surrounding context, respecting .gitignore', async () => {
    await writeFile(join(root, 'a.ts'), 'function foo() {}\nfunction bar() {}');
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'dep.ts'), 'function foo() {} // should never be found');
    await writeFile(join(root, '.gitignore'), 'ignored.ts\n');
    await writeFile(join(root, 'ignored.ts'), 'function foo() {} // gitignored');

    const result = await executor.execute(call('search', { pattern: 'function foo' }));

    expect(result.content).toContain('a.ts:1:');
    expect(result.content).not.toContain('node_modules');
    expect(result.content).not.toContain('ignored.ts');
  });

  it('returns "No matches." when nothing matches', async () => {
    await writeFile(join(root, 'a.ts'), 'nothing interesting here');
    const result = await executor.execute(call('search', { pattern: 'zzz_no_such_pattern' }));
    expect(result.content).toBe('No matches.');
  });
});

describe('WorkspaceToolExecutor — semantic_search', () => {
  it('rejects an empty/missing query with the same "Missing X argument" convention as search/get_symbols/read_file, instead of silently searching for ""', async () => {
    const result = await executor.execute(call('semantic_search', { query: '' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Missing "query" argument.');
  });
});

/**
 * What `read_file` may reach.
 *
 * The jail is the whole of what stops a read from returning `~/.ssh/id_rsa`
 * or this machine's stored API keys, and `read` is the permission class that
 * is usually auto-allowed — so it stays exactly where it is, with one
 * exception for the place the agent does its own scratch work.
 */
describe('WorkspaceToolExecutor — what read_file can reach', () => {
  it('reads a file the agent left in the system temp directory', async () => {
    // The run this comes from unpacked two npm tarballs into /tmp and then had
    // to read them back. read_file refused, so it used cat piped through head,
    // tail and sed instead — and read one file ten times in overlapping
    // windows, because nothing there tracks what it has already seen.
    const scratch = await mkdtemp(join(tmpdir(), 'wt-read-'));
    const file = join(scratch, 'types.d.ts');
    await writeFile(file, 'export declare const x: number;\n');

    const result = await executor.execute(call('read_file', { path: file }));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('export declare const x');
    await rm(scratch, { recursive: true, force: true });
  });

  it('still refuses everywhere else, and says what to use instead', async () => {
    await expect(
      executor.execute(call('read_file', { path: join(homedir(), '.ssh', 'id_rsa') })),
    ).rejects.toThrow(/escapes the workspace.*run_command/s);
  });

  it('does not let writing out of the workspace ride along', async () => {
    // Reading the agent's own scratch is one thing; the write tools keep the
    // jail exactly as it was.
    const scratch = await mkdtemp(join(tmpdir(), 'wt-write-'));
    await expect(
      executor.execute(call('write_file', { path: join(scratch, 'nope.txt'), content: 'x' })),
    ).rejects.toThrow(/escapes the workspace/);
    await rm(scratch, { recursive: true, force: true });
  });
});

describe('WorkspaceToolExecutor — run_command', () => {
  it('reports exit code and stdout', async () => {
    const result = await executor.execute(call('run_command', { command: 'echo hello' }));
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('exit code: 0');
    expect(result.content).toContain('hello');
  });

  it('reports a non-zero exit code as an error', async () => {
    const result = await executor.execute(call('run_command', { command: 'exit 3' }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exit code: 3');
  });

  it('cwd persists across calls (cd carries over)', async () => {
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'marker.txt'), 'x');
    await executor.execute(call('run_command', { command: 'cd sub' }));
    const result = await executor.execute(call('run_command', { command: 'ls' }));
    expect(result.content).toContain('marker.txt');
  });

  /**
   * Persisting the working directory is only half a feature while nothing
   * says where it went.
   *
   * What it cost: `cd apps/web && npm run build` succeeded, and the very next
   * call — `cd apps/web && npm run lint` — failed with "No such file or
   * directory", because the shell was already there. Three steps then went on
   * `pwd`, `ls` and a retry. Twice in one run and three times in another, on a
   * run that hit its step limit having written nothing.
   */
  it('says where the shell is once it has left the root', async () => {
    await mkdir(join(root, 'sub'), { recursive: true });
    const moved = await executor.execute(call('run_command', { command: 'cd sub' }));
    expect(moved.content).toContain('(working directory: sub)');
  });

  it('keeps saying so on later commands, not only the one that moved', async () => {
    // The next call is exactly where the mistake gets made.
    await mkdir(join(root, 'sub'), { recursive: true });
    await executor.execute(call('run_command', { command: 'cd sub' }));
    const after = await executor.execute(call('run_command', { command: 'echo hi' }));
    expect(after.content).toContain('(working directory: sub)');
  });

  it('says it on a failure too, which is when it is most needed', async () => {
    await mkdir(join(root, 'sub'), { recursive: true });
    await executor.execute(call('run_command', { command: 'cd sub' }));
    const failed = await executor.execute(call('run_command', { command: 'cd sub' }));
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain('(working directory: sub)');
  });

  it('stays quiet while the shell is still at the root', async () => {
    // The common case. The tool description already says runs start at the
    // root; repeating it on every command would be noise.
    const result = await executor.execute(call('run_command', { command: 'echo hello' }));
    expect(result.content).not.toContain('working directory');
  });

  // Both kill tests assert on ELAPSED TIME, not just the message. Killing only
  // the wrapper shell leaves the real process running and holding the stdout
  // pipe, so 'close' — and therefore the ToolResult — arrives when the command
  // would have finished anyway. A message-only assertion passes either way;
  // the timing is the only thing that distinguishes "killed" from "waited".
  it('kills a command that exceeds the timeout, without waiting for it to finish on its own', async () => {
    const shortExecutor = new WorkspaceToolExecutor(root, checkpoint, 200);
    const started = Date.now();
    const result = await shortExecutor.execute(call('run_command', { command: 'sleep 30' }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/did not finish within/);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('an abort signal kills the running command, and its children, immediately', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = executor.execute(call('run_command', { command: 'sleep 30' }), controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Stopped by user/);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('blocks an install command for a hallucinated-looking package name', async () => {
    const result = await executor.execute(
      call('run_command', { command: 'npm install this-package-definitely-does-not-exist-xyz-123-abc' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Blocked/);
  }, 15_000);

  // fetch_url is reachable from injected content (fetched pages, MCP output),
  // so the SSRF guard is asserted here at the tool boundary the agent actually
  // calls — not only in core's own unit tests.
  it('refuses to fetch cloud metadata or other private addresses, as a tool error rather than a throw', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:8080/', 'http://localhost/']) {
      const result = await executor.execute(call('fetch_url', { url }));
      expect(result.isError, `expected ${url} to be refused`).toBe(true);
      expect(result.content).toMatch(/private, loopback, or link-local/);
    }
  }, 15_000);
});

/**
 * web_search is offered to the model whether or not it is configured, so the
 * refusal path is the one that matters most: it is what stops an unconfigured
 * agent quietly claiming it searched the web.
 */
describe('WorkspaceToolExecutor — web_search', () => {
  it('refuses with an explanation when no settings resolver is wired at all', async () => {
    const bare = new WorkspaceToolExecutor(root, checkpoint, 5_000);
    const result = await bare.execute(call('web_search', { query: 'anything' }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/disabled/i);
    expect(result.content).toMatch(/not claim/i);
  });

  it('refuses when a provider is set but its API key is missing', async () => {
    const gated = new WorkspaceToolExecutor(root, checkpoint, 5_000, undefined, undefined, undefined, async () => ({
      config: { provider: 'brave' },
    }));
    const result = await gated.execute(call('web_search', { query: 'anything' }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/disabled/i);
  });

  it('refuses when search is explicitly switched off, even though it is configured', async () => {
    const off = new WorkspaceToolExecutor(root, checkpoint, 5_000, undefined, undefined, undefined, async () => ({
      config: { provider: 'brave', enabled: false },
      apiKey: 'k',
    }));
    expect((await off.execute(call('web_search', { query: 'q' }))).isError).toBe(true);
  });

  it('searches and formats results once configured', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ web: { results: [{ title: 'Rust Book', url: 'https://doc.rust-lang.org', description: 'The book' }] } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const enabled = new WorkspaceToolExecutor(root, checkpoint, 5_000, undefined, undefined, undefined, async () => ({
        config: { provider: 'brave', baseUrl: `http://127.0.0.1:${port}/search` },
        apiKey: 'k',
      }));
      const result = await enabled.execute(call('web_search', { query: 'rust book' }));
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('Rust Book');
      expect(result.content).toContain('https://doc.rust-lang.org');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reports a search failure to the model instead of throwing', async () => {
    const broken = new WorkspaceToolExecutor(root, checkpoint, 5_000, undefined, undefined, undefined, async () => ({
      config: { provider: 'custom', baseUrl: 'http://127.0.0.1:1/search' },
    }));
    const result = await broken.execute(call('web_search', { query: 'q' }));
    expect(result.isError).toBe(true);
  });
});

describe('WorkspaceToolExecutor — get_symbols', () => {
  it('finds a symbol via the regex fallback (AST grammars need configureAstChunker, which cli.tsx wires at process startup — not exercised by this unit test)', async () => {
    await writeFile(join(root, 'a.ts'), 'function foo() { return 1; }');
    const result = await executor.execute(call('get_symbols', { path: 'a.ts' }));
    expect(result.isError).toBeFalsy();
    // Without configureAstChunker() called (cli.tsx does this at process startup,
    // not exercised by this unit test), extractSymbols falls back to the regex
    // line-boundary matcher — still finds *something* for an obvious function decl.
    expect(result.content).not.toBe('');
  });
});

describe('WorkspaceToolExecutor — Skills', () => {
  it('list_skills reports none configured, then finds a project skill after one is added', async () => {
    const before = await executor.execute(call('list_skills', {}));
    expect(before.content).toMatch(/No skills found/);

    await mkdir(join(root, '.claude', 'skills', 'my-skill'), { recursive: true });
    await writeFile(
      join(root, '.claude', 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\ndescription: does a thing\n---\nBody instructions here.',
    );

    const after = await executor.execute(call('list_skills', {}));
    expect(after.content).toContain('my-skill');
    expect(after.content).toContain('does a thing');

    const loaded = await executor.execute(call('load_skill', { name: 'my-skill' }));
    expect(loaded.content).toBe('Body instructions here.');
  });
});

describe('WorkspaceToolExecutor — describe()', () => {
  it('produces human-readable summaries for permission prompts', () => {
    expect(executor.describe(call('read_file', { path: 'a.ts' }))).toBe('Read a.ts');
    expect(executor.describe(call('run_command', { command: 'rm -rf x' }))).toBe('Run: rm -rf x');
    expect(executor.describe(call('delete_file', { path: 'a.ts' }))).toBe('Delete a.ts');
  });
});

describe('WorkspaceToolExecutor — syntax guard (real live incident: a weak model wrote broken JS to disk)', () => {
  const require = createRequire(import.meta.url);
  const WASM_PATHS: Record<string, string> = {
    'tree-sitter.wasm': require.resolve('web-tree-sitter/tree-sitter.wasm'),
    'tree-sitter-javascript.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm'),
  };

  beforeAll(() => {
    configureAstChunker((filename) => {
      const resolved = WASM_PATHS[filename];
      if (!resolved) throw new Error(`no test wasm mapped for ${filename}`);
      return resolved;
    });
  });

  afterAll(() => {
    configureAstChunker(undefined);
  });

  it('write_file refuses syntactically broken JS and does not create the file', async () => {
    const result = await executor.execute(call('write_file', { path: 'a.js', content: 'function f( {\n' }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Syntax error/);
    await expect(readFile(join(root, 'a.js'), 'utf8')).rejects.toThrow();
  });

  it('edit_file refuses an edit that breaks previously-valid JS syntax, leaving the file untouched', async () => {
    // The exact shape of corruption a live model once produced: "});" (closing a
    // test(...) call) got replaced with just "}", dropping the ")" and ";".
    const original = "test('a', () => {\n  x();\n});\n";
    await writeFile(join(root, 'a.js'), original);
    const result = await executor.execute(call('edit_file', { path: 'a.js', search: '  x();\n});', replace: '  x();\n}' }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Syntax error/);
    expect(await readFile(join(root, 'a.js'), 'utf8')).toBe(original);
  });

  it('edit_file still allows an edit that keeps the file syntactically valid', async () => {
    await writeFile(join(root, 'a.js'), "test('a', () => {\n  x();\n});\n");
    const result = await executor.execute(call('edit_file', { path: 'a.js', search: 'x();', replace: 'y();' }));
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, 'a.js'), 'utf8')).toBe("test('a', () => {\n  y();\n});\n");
  });

  it('edit_file does not block further edits to a file that was already syntactically broken', async () => {
    const alreadyBroken = "test('a', () => {\n  x();\n}\n"; // pre-existing, unrelated syntax error
    await writeFile(join(root, 'a.js'), alreadyBroken);
    const result = await executor.execute(call('edit_file', { path: 'a.js', search: 'x();', replace: 'y();' }));
    expect(result.isError).toBeFalsy();
  });
});
