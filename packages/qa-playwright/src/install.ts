import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Download Playwright's own Chromium — for machines with no Chrome or Edge.
 *
 * Only ever on request (`heapcode qa install`), never as a side effect of
 * installing Heap Code: it is a ~150 MB download most people do not need,
 * because the driver uses the browser they already have.
 */
export function installChromium(onOutput: (line: string) => void = () => {}): Promise<void> {
  const require = createRequire(import.meta.url);
  const cli = join(dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) onOutput(line);
    };
    child.stdout.on('data', forward);
    child.stderr.on('data', forward);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Installing Chromium failed (exit ${code}).`))));
  });
}
