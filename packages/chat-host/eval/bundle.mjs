/*
 * Bundle the benchmark runner before running it.
 *
 * Node can strip types, but it does not rewrite the `.js` specifiers this repo
 * writes in TypeScript source (the NodeNext convention), so `node run.ts`
 * resolves `providers/types.js` and finds nothing. esbuild is how every other
 * entry point here is built; the runner uses the same one rather than a
 * second answer.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'run.ts')],
  outfile: join(here, '.out', 'run.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Same reasoning as the CLI's: native/optional deps stay resolvable at
  // runtime rather than being inlined.
  external: ['ws', 'bufferutil', 'utf-8-validate', 'fsevents', 'pdf-parse', 'mammoth'],
  banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
