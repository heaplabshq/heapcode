import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PERSONAS,
  filterToolsForPersona,
  getPersona,
  intersectPersonas,
  filesystemMutatingBlockedMessage,
  looksFilesystemMutating,
  type ToolDefinition,
} from '../src/index.js';

// The union of what packages/cli/test/personas.test.ts and
// packages/vscode/test/personas.test.ts each asserted before personas moved
// here — the two hosts tested the same (duplicated) module from slightly
// different angles, and both sets of cases are kept.
const TOOLS: ToolDefinition[] = [
  { name: 'read_file', description: '', parameters: { type: 'object', properties: {} }, permission: 'read' },
  { name: 'write_file', description: '', parameters: { type: 'object', properties: {} }, permission: 'write' },
  { name: 'run_command', description: '', parameters: { type: 'object', properties: {} }, permission: 'execute' },
  { name: 'delete_file', description: '', parameters: { type: 'object', properties: {} }, permission: 'destructive' },
];

describe('getPersona', () => {
  it('resolves a known id', () => {
    expect(getPersona('architect').id).toBe('architect');
  });

  it('falls back to the default (agent) persona for an unknown or missing id', () => {
    expect(getPersona('nonexistent').id).toBe('agent');
    expect(getPersona('nope').id).toBe('agent');
    expect(getPersona(undefined).id).toBe('agent');
  });
});

describe('filterToolsForPersona', () => {
  it('the default agent persona applies no restriction', () => {
    expect(filterToolsForPersona(TOOLS, getPersona('agent'))).toEqual(TOOLS);
  });

  it('architect persona keeps only read tools', () => {
    const filtered = filterToolsForPersona(TOOLS, getPersona('architect'));
    expect(filtered.map((t) => t.name)).toEqual(['read_file']);
  });

  it('debug persona keeps read + execute, excludes write and destructive', () => {
    const filtered = filterToolsForPersona(TOOLS, getPersona('debug'));
    expect(filtered.map((t) => t.name)).toEqual(['read_file', 'run_command']);
  });

  it('reviewer persona keeps only read tools', () => {
    const filtered = filterToolsForPersona(TOOLS, getPersona('reviewer'));
    expect(filtered.map((t) => t.name)).toEqual(['read_file']);
  });

  it('every built-in persona is reachable by id and has a non-empty label/description', () => {
    for (const persona of BUILTIN_PERSONAS) {
      expect(getPersona(persona.id)).toBe(persona);
      expect(persona.label.length).toBeGreaterThan(0);
      expect(persona.description.length).toBeGreaterThan(0);
    }
  });
});

describe('intersectPersonas', () => {
  it('a delegated sub-agent cannot exceed a restricted parent persona (the escalation this exists to prevent)', () => {
    // Debug (read+execute) delegates without naming a persona — requested defaults to
    // unrestricted "agent". The sub-agent must still be capped at read+execute, not
    // silently gain write/destructive access the parent itself doesn't have.
    const effective = intersectPersonas(getPersona('debug'), getPersona('agent'));
    expect(effective.allowedPermissions).toEqual(['read', 'execute']);
    expect(filterToolsForPersona(TOOLS, effective).map((t) => t.name)).toEqual(['read_file', 'run_command']);
  });

  it('narrows further when the requested persona is stricter than the parent', () => {
    const effective = intersectPersonas(getPersona('debug'), getPersona('reviewer'));
    expect(filterToolsForPersona(TOOLS, effective).map((t) => t.name)).toEqual(['read_file']);
  });

  it('an unrestricted parent (default agent) imposes no extra narrowing', () => {
    const effective = intersectPersonas(getPersona('agent'), getPersona('debug'));
    expect(effective.allowedPermissions).toEqual(['read', 'execute']);
    expect(filterToolsForPersona(TOOLS, effective).map((t) => t.name)).toEqual(['read_file', 'run_command']);
  });

  it('a stricter parent wins over a broader request', () => {
    expect(intersectPersonas(getPersona('architect'), getPersona('debug')).allowedPermissions).toEqual(['read']);
  });

  it('both unrestricted stays unrestricted', () => {
    const effective = intersectPersonas(getPersona('agent'), getPersona('agent'));
    expect(filterToolsForPersona(TOOLS, effective)).toEqual(TOOLS);
  });
});

describe('looksFilesystemMutating', () => {
  it('flags directory/file mutation commands (the Debug-persona escape this exists to close)', () => {
    for (const cmd of [
      'mkdir new-folder',
      'mkdir -p src/new-folder',
      'rm -rf dist',
      'rm -rf build',
      'touch notes.txt',
      'cp a.txt b.txt',
      'mv a.txt b.txt',
      'sed -i "s/x/y/" file.ts',
      'sed -i s/a/b/ f.txt',
      'git commit -am "wip"',
      'git commit -m x',
      'git checkout -- file.ts',
      'echo hi > out.txt',
      'echo x > out.txt',
      'ls -la && mkdir sub',
    ]) {
      expect(looksFilesystemMutating(cmd), cmd).toBe(true);
    }
  });

  it('does not flag ordinary read/execute commands', () => {
    for (const cmd of [
      'npm test',
      'pnpm test',
      'git status',
      'git diff',
      'ls -la',
      'cat foo.txt',
      'pytest -q',
      'command > /dev/null 2>&1',
      'echo x > /dev/null',
      'node script.js 2>&1',
    ]) {
      expect(looksFilesystemMutating(cmd), cmd).toBe(false);
    }
  });
});

describe('filesystemMutatingBlockedMessage', () => {
  /**
   * The exact text both hosts sent before the guard moved server-side in
   * Phase 2 (packages/vscode/src/agent/controller.ts:280-281 and
   * packages/cli/src/ink/App.tsx:1063-1064 at commit 6a8d443). The second
   * sentence went missing in the move and is the actionable half — without it
   * the model learns it was blocked but not what to do about it.
   */
  it('is the full two-sentence message, including the way forward', () => {
    const message = filesystemMutatingBlockedMessage(getPersona('architect'));

    expect(message).toBe(
      'Blocked: this command looks like it would create, modify, or delete files, which the ' +
        'Architect persona does not allow. Use a persona with file-editing tools instead.',
    );
  });

  it('names the persona that did the blocking', () => {
    expect(filesystemMutatingBlockedMessage(getPersona('debug'))).toContain('Debug persona does not allow');
    expect(filesystemMutatingBlockedMessage(getPersona('reviewer'))).toContain('Reviewer persona does not allow');
  });
});
