import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs build script, no types.
import { OUT, bundleInspect } from '../scripts/buildInspect.mjs';

describe('inspect bundle', () => {
  it('is up to date with @heapcode/page', async () => {
    const fresh: string = await bundleInspect();
    expect(readFileSync(OUT as string, 'utf8'), 'Run `pnpm --filter @heapcode/qa-playwright build:inspect`').toBe(fresh);
  });
});
