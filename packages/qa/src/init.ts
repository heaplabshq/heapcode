import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, DEFAULT_SECRETS_FILE, FLOWS_DIR, RESULTS_DIR, STEPS_DIR } from './workspace.js';

/**
 * A starter folder: settings, one example flow, an empty steps folder, and a
 * .gitignore so run results and test secrets stay out of commits.
 *
 * Never overwrites. Running it on a folder that already has some of these
 * fills in only what is missing, so it is safe to run twice.
 */
export function initWorkspace(dir: string, options: { baseUrl?: string } = {}): string[] {
  const baseUrl = options.baseUrl ?? 'http://localhost:3000';
  const created: string[] = [];
  const write = (path: string, content: string): void => {
    const full = join(dir, path);
    if (existsSync(full)) return;
    writeFileSync(full, content);
    created.push(path);
  };
  mkdirSync(join(dir, FLOWS_DIR), { recursive: true });
  mkdirSync(join(dir, STEPS_DIR), { recursive: true });

  write(
    CONFIG_FILE,
    `# Heap QA settings for this folder.
baseUrl: ${baseUrl}

# Addresses other than localhost that tests may open, e.g. a staging site.
# targets:
#   - https://staging.example.com

# Test passwords and keys, used in flows as {{secret:NAME}}. Never committed.
# secretsFile: ${DEFAULT_SECRETS_FILE}

# browser:
#   channel: chrome      # chrome | msedge | chromium
#   headless: true
# timeout: 10000         # how long a step may wait, in ms
`,
  );
  write(
    join(FLOWS_DIR, 'home.yaml'),
    `name: home page loads
steps:
  - goto: /
    intent: open the home page
  - expect: noConsoleErrors
`,
  );
  write(join(STEPS_DIR, '.gitkeep'), '');
  write('.gitignore', `${RESULTS_DIR}/\n${DEFAULT_SECRETS_FILE}\n`);
  return created;
}
