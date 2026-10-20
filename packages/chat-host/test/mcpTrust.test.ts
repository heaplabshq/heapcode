import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetMcpTrust, isTrusted, readMcpTrust, trustFor, trustMcp } from '../src/mcpTrust.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-trust-'));
  file = join(dir, 'mcp-trust.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('always-allowed connector tools', () => {
  it('trusts one tool, or every tool of its server, and is kept on disk', () => {
    trustMcp('mcp__notion__notion-search', 'tool', file);
    let trust = readMcpTrust(file);
    expect(isTrusted('mcp__notion__notion-search', trust)).toBe(true);
    expect(isTrusted('mcp__notion__notion-fetch', trust)).toBe(false);
    expect(trustFor('notion', trust)).toBe(1);

    trustMcp('mcp__notion__notion-fetch', 'server', file);
    trust = readMcpTrust(file);
    expect(isTrusted('mcp__notion__notion-create-pages', trust)).toBe(true);
    expect(isTrusted('mcp__github__create_issue', trust)).toBe(false);
    expect(trustFor('notion', trust)).toBe('all');
    // Never anything that isn't a connector's tool.
    expect(isTrusted('read_file', { servers: ['read_file'], tools: ['read_file'] })).toBe(false);
  });

  it('forgets everything about a server, by its display name', () => {
    trustMcp('mcp__my_server__a', 'tool', file);
    trustMcp('mcp__my_server__b', 'server', file);
    trustMcp('mcp__other__c', 'tool', file);
    forgetMcpTrust('my server', file);
    expect(readMcpTrust(file)).toEqual({ servers: [], tools: ['mcp__other__c'] });
  });
});
