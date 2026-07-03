import { describe, expect, it } from 'vitest';
import { parseSlashCommand, renderTemplate } from '../src/prompts/builtins.js';

describe('parseSlashCommand', () => {
  it('parses a known command with input', () => {
    const parsed = parseSlashCommand('/explain what does this do');
    expect(parsed?.prompt.command).toBe('explain');
    expect(parsed?.input).toBe('what does this do');
  });

  it('parses a bare command', () => {
    const parsed = parseSlashCommand('/review');
    expect(parsed?.prompt.command).toBe('review');
    expect(parsed?.input).toBe('');
  });

  it('returns undefined for unknown commands and plain text', () => {
    expect(parseSlashCommand('/frobnicate this')).toBeUndefined();
    expect(parseSlashCommand('explain this')).toBeUndefined();
  });
});

describe('renderTemplate', () => {
  it('substitutes variables and trims', () => {
    expect(renderTemplate('Do {thing} now. {input}', { thing: 'X', input: '' })).toBe(
      'Do X now.',
    );
  });

  it('leaves unknown placeholders intact', () => {
    expect(renderTemplate('{unknown}', {})).toBe('{unknown}');
  });
});
