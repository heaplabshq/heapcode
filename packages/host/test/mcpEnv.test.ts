/**
 * Where a connector's credential is written, and what happens to it after.
 *
 * `childEnv` stopped passing the shell's variables to third-party servers, so
 * anything a server genuinely needs now has to be named per server — which
 * only helps if there is somewhere to name it, and if editing the command
 * beside it does not quietly take it away.
 */
import { describe, expect, it } from 'vitest';
import { parseMcpServerEnv, describeMcpServer, withEnv } from '../src/agent/mcpConfig.js';
import type { McpServerConfig } from '../src/config/store.js';

/** A config store holding one server, enough for `withEnv` to read. */
function store(server: McpServerConfig) {
  return { load: () => Promise.resolve({ mcpServers: { notion: server } }) };
}

describe('parseMcpServerEnv', () => {
  it('reads KEY=value lines, keeping = inside a value', () => {
    expect(parseMcpServerEnv('NOTION_TOKEN=ntn_abc\nBASE64=aGk=')).toEqual({
      NOTION_TOKEN: 'ntn_abc',
      BASE64: 'aGk=',
    });
  });

  it('takes what a .env file looks like, since that is where these are pasted from', () => {
    expect(parseMcpServerEnv('# a comment\n\n  KEY = "quoted value"  ')).toEqual({ KEY: 'quoted value' });
  });

  it('refuses a line that is not a variable', () => {
    expect(parseMcpServerEnv('just some words')).toEqual({ error: expect.stringContaining('KEY=value') });
    expect(parseMcpServerEnv('9LIVES=x')).toEqual({ error: expect.stringContaining('usable variable name') });
  });
});

describe('withEnv', () => {
  const command: McpServerConfig = { command: 'npx', args: ['-y', 'server'] };

  it('keeps a stored credential when the panel edits only the command', async () => {
    // The panel is never sent the values, so it cannot send them back. Absent
    // has to mean "leave them alone" or every edit would drop the token.
    const kept = await withEnv(store({ ...command, env: { NOTION_TOKEN: 'ntn_abc' } }), 'notion', command, undefined);
    expect(kept.env).toEqual({ NOTION_TOKEN: 'ntn_abc' });
  });

  it('replaces them when something is typed', async () => {
    const next = await withEnv(store({ ...command, env: { OLD: 'x' } }), 'notion', command, 'NEW=y');
    expect(next.env).toEqual({ NEW: 'y' });
  });

  it('removes them on an explicit empty', async () => {
    const cleared = await withEnv(store({ ...command, env: { OLD: 'x' } }), 'notion', command, '');
    expect(cleared.env).toBeUndefined();
  });

  it('surfaces a bad line rather than saving half of it', async () => {
    await expect(withEnv(store(command), 'notion', command, 'nonsense')).rejects.toThrow(/KEY=value/);
  });
});

describe('describeMcpServer', () => {
  it('never puts a credential in the string the settings row prints', () => {
    const shown = describeMcpServer({ command: 'npx', args: ['-y', 'server'], env: { NOTION_TOKEN: 'ntn_secret' } });
    expect(shown).toBe('npx -y server');
    expect(shown).not.toContain('ntn_secret');
  });
});
