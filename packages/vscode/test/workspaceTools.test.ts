import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCall } from '@heapcode/core';
import { configureAstChunker } from '@heapcode/core';
import { WorkspaceToolExecutor } from '../src/agent/workspaceTools.js';
import { SessionCheckpoint } from '../src/agent/checkpoint.js';
import { Uri, __setWorkspaceRoot } from './vscodeStub.js';

/**
 * Write-path guard coverage, ported from packages/cli/test/workspaceTools.test.ts —
 * the CLI grew these guards first and they were missing here (the ambiguity
 * one covers a real incident where a multi-match search silently corrupted a
 * file). Runs against a real temp directory through the vscode stub, so
 * "nothing was written" is asserted by reading the file back, not by trusting
 * the returned message.
 */

let root: string;
let executor: WorkspaceToolExecutor;
let checkpoint: SessionCheckpoint;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heapcode-vscode-tools-'));
  __setWorkspaceRoot(root);
  checkpoint = new SessionCheckpoint();
  executor = new WorkspaceToolExecutor(Uri.file(root), checkpoint, 5_000);
});

afterEach(async () => {
  __setWorkspaceRoot(undefined);
  await rm(root, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>, id = '1'): ToolCall {
  return { id, name, args };
}

describe('WorkspaceToolExecutor — edit_file ambiguity guard', () => {
  it('refuses to guess when the search text matches more than one place, and does not write anything (real live incident: this exact ambiguity once silently corrupted a file)', async () => {
    const original = 'a();\n});\nb();\n});\nc();\n});';
    await writeFile(join(root, 'a.txt'), original);
    const result = await executor.execute(call('edit_file', { path: 'a.txt', search: '});', replace: 'DONE;' }));
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/matches 3 different places/);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(original);
  });

  it('still applies an edit whose search text is unique', async () => {
    await writeFile(join(root, 'a.txt'), 'const x = 1;\nconst y = 2;');
    const result = await executor.execute(
      call('edit_file', { path: 'a.txt', search: 'const x = 1;', replace: 'const x = 100;' }),
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('const x = 100;\nconst y = 2;');
  });

  it('multi_edit refuses an ambiguous edit and writes nothing, including earlier edits that did match', async () => {
    const original = 'first\na();\n});\nb();\n});';
    await writeFile(join(root, 'a.txt'), original);
    const result = await executor.execute(
      call('multi_edit', {
        path: 'a.txt',
        edits: [
          { search: 'first', replace: 'FIRST' },
          { search: '});', replace: 'DONE;' },
        ],
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Edit 2\/2: "search" matches 2 different places/);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe(original);
  });
});

describe('WorkspaceToolExecutor — edit diffs', () => {
  it('edit_file result includes a diff of the actual change, not just a bare confirmation', async () => {
    await writeFile(join(root, 'a.txt'), 'const x = 1;\nconst y = 2;');
    const result = await executor.execute(
      call('edit_file', { path: 'a.txt', search: 'const x = 1;', replace: 'const x = 100;' }),
    );
    expect(result.content).toContain('-const x = 1;');
    expect(result.content).toContain('+const x = 100;');
  });

  it('multi_edit result includes a diff of the combined change', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree');
    const result = await executor.execute(
      call('multi_edit', {
        path: 'a.txt',
        edits: [
          { search: 'one', replace: 'ONE' },
          { search: 'three', replace: 'THREE' },
        ],
      }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('-one');
    expect(result.content).toContain('+ONE');
    expect(result.content).toContain('+THREE');
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
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree');
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
    const result = await executor.execute(
      call('edit_file', { path: 'a.js', search: '  x();\n});', replace: '  x();\n}' }),
    );
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

  it('multi_edit refuses a combination that breaks previously-valid JS syntax, leaving the file untouched', async () => {
    const original = "test('a', () => {\n  x();\n});\n";
    await writeFile(join(root, 'a.js'), original);
    const result = await executor.execute(
      call('multi_edit', {
        path: 'a.js',
        edits: [
          { search: '  x();', replace: '  y();' },
          { search: '});', replace: '}' },
        ],
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Syntax error/);
    expect(await readFile(join(root, 'a.js'), 'utf8')).toBe(original);
  });
});

describe('WorkspaceToolExecutor — run_command process-group kill', () => {
  // The terminal path is unavailable under the stub (createTerminal throws),
  // so this exercises the hidden child-process fallback — the one that spawns.
  it.skipIf(process.platform === 'win32')(
    'a timed-out command does not leave the real program running and blocking the result',
    async () => {
      // The CWD_MARKER wrapper makes the command multi-statement, so the shell
      // forks `sleep` as a grandchild instead of exec-ing into it. Killing only
      // the wrapper leaves that grandchild alive holding the stdout pipe, so
      // 'close' never fires and the agent blocks for the sleep's full duration
      // rather than for the timeout — the hang the CLI's killTree comment
      // describes. Signalling the whole process group is what fixes it.
      const shortExecutor = new WorkspaceToolExecutor(Uri.file(root), checkpoint, 300);
      const started = Date.now();
      const result = await shortExecutor.execute(call('run_command', { command: 'sleep 5' }));
      const elapsed = Date.now() - started;

      expect(result.content).toMatch(/did not finish within/i);
      // Comfortably under the 5s sleep: without the group kill this waits it out.
      expect(elapsed).toBeLessThan(2_500);
    },
    10_000,
  );

  it.skipIf(process.platform === 'win32')('Stop kills the whole group too, not just the wrapper', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const promise = executor.execute(call('run_command', { command: 'sleep 5' }), controller.signal);
    setTimeout(() => controller.abort(), 200);
    const result = await promise;

    expect(result.content).toMatch(/stopped/i);
    expect(Date.now() - started).toBeLessThan(2_500);
  }, 10_000);
});
