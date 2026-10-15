import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import type { QaConfig } from './flow.js';
import { parseConfig } from './parse.js';
import { CONFIG_FILE } from './workspace.js';

/**
 * The settings a page can change, written back into heapqa.yaml.
 *
 * Edits the file in place rather than rewriting it, so the comments a person
 * (or `init`) left there survive. Checked with the same parser a run uses
 * before anything is written: a bad address is refused here, not discovered
 * at the start of the next run.
 */
export interface QaSettingsPatch {
  baseUrl?: string;
  targets?: string[];
  heal?: QaConfig['heal'];
  timeout?: number;
  channel?: 'chrome' | 'msedge' | 'chromium';
  secretsFile?: string;
}

export function writeSettings(dir: string, patch: QaSettingsPatch): QaConfig {
  const file = join(dir, CONFIG_FILE);
  const doc = parseDocument(existsSync(file) ? readFileSync(file, 'utf8') : '');
  if (doc.errors.length) throw new Error(`${CONFIG_FILE} has a mistake in it — fix it by hand first: ${doc.errors[0]!.message.split('\n')[0]}`);
  if (!doc.contents) doc.contents = doc.createNode({}) as never;

  const set = (path: string[], value: unknown): void => {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) doc.deleteIn(path);
    else doc.setIn(path, value);
  };
  if ('baseUrl' in patch) set(['baseUrl'], patch.baseUrl?.trim());
  if ('targets' in patch) set(['targets'], patch.targets?.map((t) => t.trim()).filter(Boolean));
  if ('heal' in patch) set(['heal'], patch.heal === 'ai' ? undefined : patch.heal);
  if ('timeout' in patch) set(['timeout'], patch.timeout && patch.timeout !== 10_000 ? patch.timeout : undefined);
  if ('secretsFile' in patch) set(['secretsFile'], patch.secretsFile?.trim());
  if ('channel' in patch) {
    set(['browser', 'channel'], patch.channel);
    const browser = doc.getIn(['browser']) as { items?: unknown[] } | undefined;
    if (browser && Array.isArray(browser.items) && browser.items.length === 0) doc.deleteIn(['browser']);
  }

  const text = doc.toString();
  const parsed = parseConfig(text);
  if (!parsed.ok) throw new Error(parsed.errors.map((e) => e.message).join(' '));
  writeFileSync(file, text);
  return parsed.value;
}
