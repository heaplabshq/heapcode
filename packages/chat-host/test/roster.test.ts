import { describe, expect, it } from 'vitest';
import { agentToolDefinitions } from '@heapcode/host';
import { CHAT_TOOL_NAMES, chatToolDefinitions, permissionFor } from '../src/tools.js';

/**
 * The guardrail this file exists for is docs/CHAT_MODE_PLAN.md §Guardrails 2:
 * the two products' rosters are separate arrays, never one array behind a
 * filter. The failure that matters is silent and one-directional — a tool
 * added for Heap Code quietly becoming available to a knowledge assistant —
 * so it is named here rather than left to review.
 */
describe('Heap Chat roster', () => {
  it('offers nothing that can change the folder or the machine', () => {
    const forbidden = [
      'write_file',
      'edit_file',
      'multi_edit',
      'delete_file',
      'rename_file',
      'create_directory',
      'download_file',
      'run_command',
      'run_tests',
    ];
    for (const name of forbidden) {
      expect(CHAT_TOOL_NAMES.has(name), `${name} must not be offered`).toBe(false);
    }
  });

  it('offers nothing code-shaped', () => {
    for (const name of ['repo_map', 'get_symbols', 'delegate_task', 'check_package_exists']) {
      expect(CHAT_TOOL_NAMES.has(name), `${name} must not be offered`).toBe(false);
    }
  });

  it('is a separate array from the coding roster, not a filtered view of it', () => {
    expect(chatToolDefinitions).not.toBe(agentToolDefinitions);
    // `remember` exists only here, which is the proof the two are independent
    // rather than one being a subset of the other.
    expect(CHAT_TOOL_NAMES.has('remember')).toBe(true);
    expect(agentToolDefinitions.some((t) => t.name === 'remember')).toBe(false);
  });

  it('can read, search and look — the four a question about a folder needs', () => {
    for (const name of ['read_file', 'list_dir', 'search', 'semantic_search']) {
      expect(CHAT_TOOL_NAMES.has(name), `${name} must be offered`).toBe(true);
    }
  });

  it('carries ask_user, without which askToContinueAtLimit is dead protocol', () => {
    // agent/loop.ts gates the "keep going?" prompt on the roster containing
    // ask_user. Dropping it makes both that and chat/askUser unreachable.
    expect(CHAT_TOOL_NAMES.has('ask_user')).toBe(true);
  });

  it('holds nothing destructive, and nothing that writes outside memory', () => {
    // Not "everything is read class": `web_search` and `fetch_url` are
    // `execute`, because reaching the network is its own risk and core
    // classifies it that way deliberately. What must hold is narrower and
    // more useful — nothing here can destroy anything, and the only writer
    // writes to the assistant's own memory.
    expect(chatToolDefinitions.filter((t) => t.permission === 'destructive')).toEqual([]);
    const writers = chatToolDefinitions.filter((t) => t.permission === 'write');
    expect(writers.map((t) => t.name)).toEqual(['remember']);
    const reachesNetwork = chatToolDefinitions.filter((t) => t.permission === 'execute');
    expect(reachesNetwork.map((t) => t.name).sort()).toEqual(['fetch_url', 'web_search']);
  });

  it('names every definition it exports, so the executor cannot disagree with the roster', () => {
    expect([...CHAT_TOOL_NAMES].sort()).toEqual(chatToolDefinitions.map((t) => t.name).sort());
  });
});

/**
 * A connector's tools are not covered by "nothing on this roster writes".
 *
 * This returned granted for them, unconditionally — below what Heap Code does
 * with the identical call, and below what Claude Desktop and Cursor do. With
 * a connector attached, `notion-update-page` ran silently in the product whose
 * empty state promises it never writes over anything.
 */
describe('what runs without asking', () => {
  it('runs Heap Chat’s own tools, which cannot change anything', () => {
    for (const name of ['read_file', 'search', 'semantic_search', 'create_artifact']) {
      expect(permissionFor(name, false, false), name).toBe('grant');
    }
  });

  it('asks before a connector’s tool, however it was registered', () => {
    expect(permissionFor('mcp__notion__update_page', true, false)).toBe('ask');
    expect(permissionFor('mcp__anything__read_thing', true, false)).toBe('ask');
  });

  it('stops asking once allowed for the conversation', () => {
    expect(permissionFor('mcp__notion__update_page', true, true)).toBe('grant');
  });

  it('refuses a name that is on neither list', () => {
    // The check is on the name, not the class the daemon reports, so a tool
    // that reached this host off-roster is refused rather than queried.
    expect(permissionFor('write_file', false, false)).toBe('deny');
    expect(permissionFor('run_command', false, true)).toBe('deny');
  });
});
