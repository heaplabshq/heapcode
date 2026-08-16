/**
 * The gate between "it built" and "it is on npm".
 *
 * Everything this checks has already shipped broken once. `0.3.0` went out
 * with `heapcode web` in the code and no `dist/web` beside it, because
 * esbuild.mjs copies the browser bundle only when `packages/web-ui/dist`
 * exists and merely *warns* when it does not — a warning inside a build whose
 * output nobody reads line by line. The command worked, printed a URL, and
 * served a 404.
 *
 * That warning is right for the build (someone iterating on the CLI has no
 * reason to build a UI they are not touching) and wrong for a publish, which
 * is the one moment the distinction stops being reversible. So the strictness
 * lives here rather than there.
 *
 * Run by npm's `prepublishOnly` hook, which fires for `npm publish` and not
 * for `npm install` — so this cannot get in the way of ordinary development.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';

const problems = [];

/** The CLI itself, and the daemon it autostarts. */
for (const entry of ['dist/cli.js', 'dist/daemon.js']) {
  if (!existsSync(entry)) problems.push(`${entry} is missing — run \`pnpm build\` from the repo root.`);
}

// The browser UI. Checked by its entry point rather than by the directory,
// because an empty or half-copied `dist/web` is exactly the state that would
// otherwise pass a existsSync on the folder.
if (!existsSync('dist/web/index.html')) {
  problems.push(
    'dist/web/index.html is missing — `heapcode web` would serve no UI.\n' +
      '    Build packages/web-ui first: `pnpm build` from the repo root does it in the right order.',
  );
} else {
  const assets = 'dist/web/assets';
  const bundles = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : [];
  if (bundles.length === 0) {
    problems.push(`${assets} contains no JavaScript — the UI build produced an empty bundle.`);
  }
}

// tree-sitter grammars are read from disk at runtime, so a missing one is a
// feature that fails on a user's machine and nowhere else.
const wasm = 'dist/wasm';
if (!existsSync(wasm) || readdirSync(wasm).filter((f) => f.endsWith('.wasm')).length === 0) {
  problems.push(`${wasm} has no grammars — the repo map and AST chunking would degrade silently.`);
}

// A stale bundle is worse than a missing one: it publishes without complaint
// and ships whatever the tree looked like days ago.
if (existsSync('dist/cli.js') && existsSync('dist/web/index.html')) {
  const age = statSync('dist/cli.js').mtimeMs - statSync('dist/web/index.html').mtimeMs;
  const HOUR = 60 * 60 * 1000;
  if (Math.abs(age) > 12 * HOUR) {
    problems.push(
      'dist/cli.js and dist/web are more than 12 hours apart — one of them is stale.\n' +
        '    Rebuild both: `pnpm build` from the repo root.',
    );
  }
}

if (problems.length > 0) {
  console.error('\n  Refusing to publish:\n');
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('');
  process.exit(1);
}

console.log('  ✓ dist/cli.js, dist/daemon.js, dist/web and dist/wasm all present.');
