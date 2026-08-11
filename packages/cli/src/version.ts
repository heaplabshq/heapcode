import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * This package's own version, read from its package.json at runtime rather
 * than baked in at build time — the esbuild bundle lands in dist/cli.js, one
 * level below the package root, so `../package.json` resolves either way.
 *
 * Used for the startup banner and as the version reported to MCP servers in
 * the initialize handshake, so those two can't drift apart.
 */
export function cliVersion(): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}
