import { describe, expect, it } from 'vitest';
import { assembleContext } from '../src/context/contextManager.js';

describe('assembleContext', () => {
  it('includes blocks in priority order with labeled headers', () => {
    const { text, included } = assembleContext([
      { label: 'Open files', content: 'b', priority: 5 },
      { label: 'Selection', content: 'a', priority: 1 },
    ]);
    expect(included).toEqual(['Selection', 'Open files']);
    expect(text.indexOf('--- Selection ---')).toBeLessThan(text.indexOf('--- Open files ---'));
  });

  it('skips empty blocks', () => {
    const { included } = assembleContext([
      { label: 'Empty', content: '   ', priority: 1 },
      { label: 'Real', content: 'x', priority: 2 },
    ]);
    expect(included).toEqual(['Real']);
  });

  it('truncates an overflowing block and drops the rest', () => {
    const big = 'x'.repeat(2000);
    const { text, included, dropped } = assembleContext(
      [
        { label: 'First', content: big, priority: 1 },
        { label: 'Second', content: big, priority: 2 },
      ],
      1000,
    );
    expect(included).toEqual(['First']);
    expect(dropped).toEqual(['Second']);
    expect(text).toContain('…[truncated]');
    expect(text.length).toBeLessThanOrEqual(1100);
  });
});
