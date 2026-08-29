import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Render the toolbar and store icons from the one SVG that defines the mark.
 *
 * Run by hand when `icon.svg` changes; the PNGs are committed, because a store
 * submission cannot depend on a machine having a rasteriser and CI has no
 * reason to own one.
 *
 * Chrome does the rasterising, which is the joke and also the right answer:
 * this repo is a Chrome extension, every developer of it has Chrome, and it is
 * the only renderer guaranteed to agree with the browser that will display the
 * result. macOS has no SVG converter that handles a gradient correctly.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];

const CHROME =
  process.env.CHROME ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// The source lives beside this script, not in `public/` -- anything in there is
// copied into the extension, and shipping the SVG the PNGs were made from adds
// bytes to every install for nobody's benefit.
const source = readFileSync(join(ROOT, 'scripts/icon.svg'), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'heapbrowse-icons-'));

for (const size of SIZES) {
  // The viewBox does the scaling; only the surface changes size.
  const sized = source.replace(
    /width="\d+" height="\d+" viewBox/,
    `width="${size}" height="${size}" viewBox`,
  );
  const svg = join(scratch, `${size}.svg`);
  writeFileSync(svg, sized);
  execFileSync(CHROME, [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    // Without this the rounded corners come out on white instead of nothing.
    '--default-background-color=00000000',
    `--screenshot=${join(ROOT, 'public/icons', `${size}.png`)}`,
    `--window-size=${size},${size}`,
    svg,
  ]);
  console.log(`public/icons/${size}.png`);
}
