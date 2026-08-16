import { describe, expect, it } from 'vitest';
import { COMMANDS, findCommand, matchCommands } from '../src/commands.js';

/**
 * The parity checklist, enforced.
 *
 * WEB_APP_PLAN §9 says every CLI slash command needs a web answer. This test
 * is what stops that from silently rotting: a command dropped from the list
 * fails here rather than becoming an "unknown command" a user discovers.
 */

/** Every command in packages/cli/src/ink/App.tsx:106-129, minus /exit. */
const CLI_COMMANDS = [
  '/help', '/model', '/profile', '/persona', '/mode', '/websearch', '/permissions',
  '/nativetools', '/settings', '/init', '/memory', '/skills', '/search', '/index',
  '/pr-review', '/mcp', '/subagents', '/clear', '/new', '/resume', '/rewind',
  '/revert', '/checkpoints',
];

describe('command parity with the CLI', () => {
  it('answers every CLI slash command', () => {
    const missing = CLI_COMMANDS.filter((name) => !findCommand(name));
    // `/exit` is deliberately absent: closing a tab is not quitting the host.
    expect(missing).toEqual([]);
  });

  it('marks unimplemented commands as pending with a milestone, never as silently missing', () => {
    for (const c of COMMANDS) {
      if (c.kind === 'pending') expect(c.milestone, `${c.name} has no milestone`).toBeTruthy();
    }
  });

  it('has no duplicate names', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('matchCommands', () => {
  it('ranks exact prefixes above substring matches', () => {
    const results = matchCommands('me');
    expect(results[0]?.name).toBe('/memory');
  });

  it('matches with or without the leading slash', () => {
    expect(matchCommands('/init')[0]?.name).toBe('/init');
    expect(matchCommands('init')[0]?.name).toBe('/init');
  });

  it('falls back to searching descriptions', () => {
    // "checkpoint" appears in /rewind's description, not its name.
    expect(matchCommands('checkpoint').map((c) => c.name)).toContain('/rewind');
  });

  it('returns everything for an empty query, so ⌘K opens as a browsable list', () => {
    expect(matchCommands('')).toHaveLength(COMMANDS.length);
  });
});

describe('findCommand', () => {
  it('ignores arguments after the command', () => {
    expect(findCommand('/model gpt-4o')?.name).toBe('/model');
  });

  it('returns undefined for something that is not a command', () => {
    expect(findCommand('/nonsense')).toBeUndefined();
  });
});
