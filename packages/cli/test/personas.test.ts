import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@heapcode/core';
import {
  filterToolsForPersona,
  getPersona,
  intersectPersonas,
  looksFilesystemMutating,
} from '../src/agent/personas.js';

const TOOLS: ToolDefinition[] = [
  { name: 'read_file', description: '', parameters: { type: 'object', properties: {} }, permission: 'read' },
  { name: 'write_file', description: '', parameters: { type: 'object', properties: {} }, permission: 'write' },
  { name: 'run_command', description: '', parameters: { type: 'object', properties: {} }, permission: 'execute' },
];

describe('personas (CLI port)', () => {
  it('architect and reviewer are read-only; debug gets read+execute; agent gets everything', () => {
    expect(filterToolsForPersona(TOOLS, getPersona('architect')).map((t) => t.name)).toEqual(['read_file']);
    expect(filterToolsForPersona(TOOLS, getPersona('reviewer')).map((t) => t.name)).toEqual(['read_file']);
    expect(filterToolsForPersona(TOOLS, getPersona('debug')).map((t) => t.name)).toEqual(['read_file', 'run_command']);
    expect(filterToolsForPersona(TOOLS, getPersona('agent'))).toEqual(TOOLS);
  });

  it('an unknown or missing id falls back to the unrestricted agent persona', () => {
    expect(getPersona(undefined).id).toBe('agent');
    expect(getPersona('nope').id).toBe('agent');
  });

  it('intersectPersonas never grants a sub-agent more than its parent (delegate_task groundwork)', () => {
    const debug = getPersona('debug');
    const agent = getPersona('agent');
    // Debug parent + unrestricted request → stays Debug-scoped.
    expect(intersectPersonas(debug, agent).allowedPermissions).toEqual(['read', 'execute']);
    // Unrestricted parent honors the request as-is.
    expect(intersectPersonas(agent, debug).allowedPermissions).toEqual(['read', 'execute']);
    // Architect parent + debug request → read only survives the intersection.
    expect(intersectPersonas(getPersona('architect'), debug).allowedPermissions).toEqual(['read']);
  });

  it('flags filesystem-mutating shell commands so write-restricted personas cannot escape via run_command', () => {
    for (const cmd of ['mkdir foo', 'rm -rf build', 'echo x > out.txt', 'git commit -m x', 'sed -i s/a/b/ f.txt']) {
      expect(looksFilesystemMutating(cmd), cmd).toBe(true);
    }
    for (const cmd of ['git status', 'pnpm test', 'ls -la', 'cat foo.txt', 'node script.js 2>&1', 'echo x > /dev/null']) {
      expect(looksFilesystemMutating(cmd), cmd).toBe(false);
    }
  });
});
