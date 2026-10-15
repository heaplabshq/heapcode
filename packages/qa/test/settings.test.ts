import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initWorkspace, loadWorkspace, writeSettings } from '../src/index.js';

describe('writeSettings', () => {
  it('changes heapqa.yaml in place, keeping its comments, and reads back the same', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heapqa-settings-'));
    initWorkspace(dir);
    const config = writeSettings(dir, { baseUrl: 'http://localhost:5173', targets: ['https://staging.example.com', ' '], heal: 'similarity', timeout: 15000, channel: 'msedge' });
    expect(config).toMatchObject({ baseUrl: 'http://localhost:5173', targets: ['https://staging.example.com'], heal: 'similarity', timeout: 15000, browser: { channel: 'msedge' } });
    const text = readFileSync(join(dir, 'heapqa.yaml'), 'utf8');
    expect(text).toContain('# Heap QA settings for this folder.');
    expect(loadWorkspace(dir).config).toEqual(config);

    // Back to the defaults: the keys go, rather than being written out.
    const back = writeSettings(dir, { targets: [], heal: 'ai', timeout: 10000, channel: undefined });
    expect(back).toMatchObject({ targets: [], heal: 'ai', timeout: 10000, browser: {} });
    expect(readFileSync(join(dir, 'heapqa.yaml'), 'utf8')).not.toMatch(/^heal:|^targets:|^browser:/m);
  });

  it('refuses what a run would refuse, and leaves the file alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heapqa-settings-'));
    initWorkspace(dir);
    const before = readFileSync(join(dir, 'heapqa.yaml'), 'utf8');
    expect(() => writeSettings(dir, { targets: ['not an address'] })).toThrow(/not an address/);
    expect(readFileSync(join(dir, 'heapqa.yaml'), 'utf8')).toBe(before);
  });
});
