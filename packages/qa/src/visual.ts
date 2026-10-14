import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Screenshot checks: does the page (or one element) still look like its
 * saved picture?
 *
 * Compared pixel by pixel (pixelmatch's perceptual difference, with
 * anti-aliasing ignored), and the check fails when more than `maxDiff` percent
 * of pixels changed. A size change fails outright — a layout that moved is
 * exactly what this check is for. The first run has no picture to compare
 * with, so it saves one and passes; `--update-snapshots` replaces them.
 */

export interface VisualResult {
  /** Percent of pixels that differ, 0–100. */
  diffPercent: number;
  /** Highlighted differences, PNG — present when anything differed. */
  diff?: Uint8Array;
  /** The pictures were not the same size: their sizes. */
  sizeMismatch?: { saved: string; now: string };
}

export function compareImages(saved: Uint8Array, now: Uint8Array): VisualResult {
  const a = PNG.sync.read(Buffer.from(saved));
  const b = PNG.sync.read(Buffer.from(now));
  if (a.width !== b.width || a.height !== b.height) {
    return { diffPercent: 100, sizeMismatch: { saved: `${a.width}×${a.height}`, now: `${b.width}×${b.height}` } };
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const changed = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1, includeAA: false });
  const diffPercent = (changed / (a.width * a.height)) * 100;
  return { diffPercent, ...(changed > 0 ? { diff: PNG.sync.write(diff) } : {}) };
}

export interface SnapshotOutcome {
  status: 'created' | 'updated' | 'matched' | 'differs';
  diffPercent: number;
  diff?: Uint8Array;
  message?: string;
}

/** Compare `now` with the picture at `path` — or save it there when there is none yet, or when updating. */
export function checkSnapshot(path: string, now: Uint8Array, options: { maxDiff: number; update: boolean }): SnapshotOutcome {
  if (!existsSync(path) || options.update) {
    const existed = existsSync(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, now);
    return { status: existed ? 'updated' : 'created', diffPercent: 0 };
  }
  const result = compareImages(readFileSync(path), now);
  if (result.sizeMismatch) {
    return { status: 'differs', diffPercent: 100, message: `it is ${result.sizeMismatch.now} now, ${result.sizeMismatch.saved} in the saved picture` };
  }
  const status = result.diffPercent > options.maxDiff ? 'differs' : 'matched';
  return { status, diffPercent: result.diffPercent, ...(result.diff ? { diff: result.diff } : {}) };
}
