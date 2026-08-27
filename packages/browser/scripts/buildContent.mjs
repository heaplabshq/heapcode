import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundle the content script as one self-contained classic script.
 *
 * It cannot go through the Vite/crxjs pipeline: crxjs only bundles content
 * scripts that are *declared* in the manifest, and declaring one means asking
 * for its `matches` at install time — the whole-web grant this design avoids
 * (see src/content/index.ts). `chrome.scripting.executeScript` takes a plain
 * file instead, which must be a single IIFE with no imports, since there is no
 * module loader in the injected context.
 *
 * Runs after `vite build`, because Vite empties dist/ first.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [resolve(ROOT, 'src/content/index.ts')],
  outfile: resolve(ROOT, 'dist/content.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome116',
  minify: true,
  legalComments: 'none',
});

console.log('dist/content.js');
