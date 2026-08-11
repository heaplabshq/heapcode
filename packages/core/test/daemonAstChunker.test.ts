import { createRequire } from 'node:module';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AST_GRAMMAR_FILES, chunkFile, configureAstChunker, enableAstChunking } from '../src/index.js';

/**
 * The design note's prerequisite 1 (docs/phase3-rag-design.md §3.3, §5.3):
 * once indexing runs in the daemon, the daemon is what chunks, and nothing
 * called configureAstChunker there. The failure mode is silent — every
 * TS/JS/Python file falls back to line-window chunking, chunk hashes stop
 * matching (`fnv1a(path:text)`, chunker.ts:60), and the whole index
 * re-embeds with no error anywhere. So these tests assert both halves:
 * the wiring works when the assets are present, and it says so when they
 * are not.
 */

const require = createRequire(import.meta.url);
/** Where the real assets live in node_modules — both esbuild configs copy from here. */
const SOURCE_WASM: Record<string, string> = {
  'tree-sitter.wasm': require.resolve('web-tree-sitter/tree-sitter.wasm'),
  'tree-sitter-typescript.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm'),
  'tree-sitter-tsx.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-tsx.wasm'),
  'tree-sitter-javascript.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-javascript.wasm'),
  'tree-sitter-python.wasm': require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm'),
};

/**
 * 20 five-line functions — long enough that both chunkers split it, which is
 * what makes them distinguishable. The AST chunker's boundaries are
 * contiguous (each chunk ends just before the next one starts,
 * astChunker.ts:162-167); the line-window fallback overlaps consecutive
 * windows by 10 lines (chunker.ts:64). That difference *is* the chunk-hash
 * mismatch this prerequisite exists to prevent, so it is what these tests
 * assert on rather than a chunk count.
 */
const SAMPLE = Array.from(
  { length: 20 },
  (_, i) => `export function fn${i}(input: number): number {\n  const scaled = input * ${i + 1};\n  return scaled + ${i};\n}\n`,
).join('\n');

function isContiguous(chunks: Array<{ startLine: number; endLine: number }>): boolean {
  return chunks.every((c, i) => i === 0 || c.startLine === chunks[i - 1]!.endLine + 1);
}

let dir: string;
let logged: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'heapcode-daemon-wasm-'));
  logged = [];
});

afterEach(async () => {
  configureAstChunker(undefined);
  await rm(dir, { recursive: true, force: true });
});

const log = async (line: string): Promise<void> => {
  logged.push(line);
};

async function populate(dest: string, files = AST_GRAMMAR_FILES): Promise<void> {
  for (const name of files) await copyFile(SOURCE_WASM[name]!, join(dest, name));
}

describe('daemon AST chunker wiring', () => {
  it('covers every grammar the chunker can dispatch to', () => {
    // Derived from LANGUAGE_BY_EXT rather than hand-listed, so a new grammar
    // cannot be added to the chunker without the asset list following it.
    expect(AST_GRAMMAR_FILES).toEqual([
      'tree-sitter.wasm',
      'tree-sitter-typescript.wasm',
      'tree-sitter-tsx.wasm',
      'tree-sitter-javascript.wasm',
      'tree-sitter-python.wasm',
    ]);
  });

  it('enables AST chunking when the wasm directory has the assets, and logs nothing', async () => {
    await populate(dir);
    await enableAstChunking(dir, log);

    expect(logged).toEqual([]);
    const chunks = await chunkFile('sample.ts', SAMPLE);
    expect(chunks.length).toBeGreaterThan(1);
    expect(isContiguous(chunks)).toBe(true);
  });

  it('falls back to line-window chunking and says so when assets are missing', async () => {
    await enableAstChunking(dir, log);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('AST-aware chunking unavailable');
    expect(logged[0]).toContain('re-embed in full');
    // Overlapping windows, not syntactic edges — different boundaries, so
    // different hashes, so a full re-embed of an index built with AST on.
    expect(isContiguous(await chunkFile('sample.ts', SAMPLE))).toBe(false);
  });

  it('treats a partial asset directory as unavailable rather than half-working', async () => {
    // A missing grammar would otherwise surface as that one language silently
    // chunking differently from the rest.
    await populate(dir, ['tree-sitter.wasm', 'tree-sitter-typescript.wasm']);
    await enableAstChunking(dir, log);

    expect(logged[0]).toContain('AST-aware chunking unavailable');
    expect(isContiguous(await chunkFile('sample.ts', SAMPLE))).toBe(false);
  });

  it('logs when no wasm directory was supplied at all', async () => {
    await enableAstChunking(undefined, log);

    expect(logged[0]).toContain('no wasm directory supplied');
  });

  it('resolves assets the way both hosts lay them out: dist/wasm beside dist/daemon.js', async () => {
    // Mirrors packages/cli/esbuild.mjs:17-24 and packages/vscode/esbuild.mjs:17-23.
    // The host entries pass join(<dir of daemon.js>, 'wasm'); this pins that
    // the daemon reads filenames straight out of that directory.
    const distDir = join(dir, 'dist');
    const wasmDir = join(distDir, 'wasm');
    await rm(wasmDir, { recursive: true, force: true });
    const { mkdir } = await import('node:fs/promises');
    await mkdir(wasmDir, { recursive: true });
    await populate(wasmDir);

    await enableAstChunking(join(dirname(join(distDir, 'daemon.js')), 'wasm'), log);

    expect(logged).toEqual([]);
    expect(isContiguous(await chunkFile('sample.ts', SAMPLE))).toBe(true);
  });
});
