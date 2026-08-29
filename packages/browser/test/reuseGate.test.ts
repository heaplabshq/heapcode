import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The reuse gate: core's browser-safe subpaths must actually bundle for a browser.
 *
 * `packages/core/test/browserSafety.test.ts` walks core's import graph and proves
 * no Node builtin is reachable. This proves the other half — that the subpaths
 * *resolve* from a consuming package and survive a real bundler. Those fail
 * differently: a barrel can be graph-clean and still unusable because its
 * `exports` map points at a moved file, or because a type the API needs is not
 * re-exported.
 *
 * `/providers` is covered by the extension build itself, which imports it. `/agent`
 * is not imported by anything until the loop lands in M2 (PLAN), so without this
 * it would go unverified for weeks — and it is the import the whole Phase 0
 * packaging change existed to unblock (REUSE.md §2). Finding out then, rather than
 * now, is the failure this test prevents.
 *
 * `platform: 'browser'` is what makes it a real check: esbuild refuses to resolve
 * a Node builtin under it instead of quietly shimming one in.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

async function bundleForBrowser(source: string) {
  return build({
    stdin: { contents: source, resolveDir: resolve(HERE, '..'), loader: 'ts' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'esnext',
    logLevel: 'silent',
  });
}

describe('@heapcode/core browser-safe subpaths', () => {
  it('bundles the agent loop for a browser target', async () => {
    // Names the loop actually needs to expose for a host to drive it, so a
    // barrel that resolves but is missing the surface still fails here.
    const result = await bundleForBrowser(`
      import { runAgent, wrapUntrusted, FINISH_TOOL, resolvePermission } from '@heapcode/core/agent';
      import type { ToolDefinition, ToolCall, ToolResult } from '@heapcode/core/agent';
      export const used = [runAgent, wrapUntrusted, FINISH_TOOL, resolvePermission];
      export type Belt = { tools: ToolDefinition[]; call: ToolCall; result: ToolResult };
    `);
    expect(result.errors).toEqual([]);
  }, 30_000);

  it('bundles the provider layer for a browser target', async () => {
    const result = await bundleForBrowser(`
      import { createProvider, providerPresets, ProviderError } from '@heapcode/core/providers';
      import type { ProviderProfileConfig, ChatMessage } from '@heapcode/core/providers';
      export const used = [createProvider, providerPresets, ProviderError];
      export type Cfg = { profile: ProviderProfileConfig; message: ChatMessage };
    `);
    expect(result.errors).toEqual([]);
  }, 30_000);

  it('bundles the context helpers for a browser target', async () => {
    const result = await bundleForBrowser(`
      import { estimateTokens } from '@heapcode/core/context';
      export const used = [estimateTokens];
    `);
    expect(result.errors).toEqual([]);
  }, 30_000);

  it('refuses the package barrel, which is Node-coupled', async () => {
    // Not a limitation being documented — this is the constraint that forced the
    // subpaths to exist. If the barrel ever becomes browser-safe this test should
    // be deleted deliberately, not silently loosened.
    const result = await bundleForBrowser(`
      import { runAgent } from '@heapcode/core';
      export const used = [runAgent];
    `).catch((error: { errors?: unknown[] }) => error);
    const errors = (result as { errors?: unknown[] }).errors ?? [];
    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toMatch(/node:/);
  }, 30_000);
});
