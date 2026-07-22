import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@heapcode/core';
import { BUILTIN_PERSONAS, filterToolsForPersona, getPersona } from '../src/agent/personas.js';

const TOOLS: ToolDefinition[] = [
  { name: 'read_file', description: '', parameters: {}, permission: 'read' },
  { name: 'write_file', description: '', parameters: {}, permission: 'write' },
  { name: 'run_command', description: '', parameters: {}, permission: 'execute' },
  { name: 'delete_file', description: '', parameters: {}, permission: 'destructive' },
];

describe('getPersona', () => {
  it('resolves a known id', () => {
    expect(getPersona('architect').id).toBe('architect');
  });

  it('falls back to the default (agent) persona for an unknown or missing id', () => {
    expect(getPersona('nonexistent').id).toBe('agent');
    expect(getPersona(undefined).id).toBe('agent');
  });
});

describe('filterToolsForPersona', () => {
  it('the default agent persona applies no restriction', () => {
    const filtered = filterToolsForPersona(TOOLS, getPersona('agent'));
    expect(filtered.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
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
