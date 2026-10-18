import { describe, expect, it } from 'vitest';
import { cleanInline, inlineMessages } from '../src/index.js';

describe('⌘J', () => {
  it('asks for the replacement only, with the note around it for context', () => {
    const [system, user] = inlineMessages({
      action: 'fix',
      selection: 'teh cat',
      before: '# T\n',
      after: '\nmore',
    });
    expect(system!.content).toMatch(/Return only the text that replaces the SELECTION/);
    expect(user!.content).toContain('WHAT TO DO: Fix spelling, grammar and punctuation only');
    expect(user!.content.endsWith('SELECTION:\nteh cat')).toBe(true);
  });

  it('takes a custom instruction as written', () => {
    const [, user] = inlineMessages({
      action: 'custom',
      instruction: 'Make it French',
      selection: 'hi',
      before: '',
      after: '',
    });
    expect(user!.content).toContain('WHAT TO DO: Make it French');
  });

  it('peels off fences, quotes and preambles, and keeps the selection’s trailing break', () => {
    expect(cleanInline('```markdown\nThe cat.\n```', 'teh cat\n')).toBe('The cat.\n');
    expect(cleanInline('Here is the improved text:\nThe cat.', 'teh cat')).toBe('The cat.');
    expect(cleanInline('"The cat."', 'teh cat')).toBe('The cat.');
    expect(cleanInline('"Quoted."', '"quoted"')).toBe('"Quoted."');
  });
});
