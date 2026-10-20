// @vitest-environment jsdom
/**
 * A malformed diagram must fail inside the app, not on the page around it.
 * Mermaid's own error path appends a "Syntax error in text" graphic to
 * <body>; the artifact preview had its own renderer that never removed it, so
 * a model's bad chart stacked bombs under Heap Chat.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const initialize = vi.fn();
const render = vi.fn(async (id: string, source: string) => {
  if (source.startsWith('bar')) {
    const scratch = document.createElement('div');
    scratch.id = `d${id}`;
    scratch.textContent = 'Syntax error in text';
    document.body.appendChild(scratch);
    throw new Error('Parse error on line 1');
  }
  return { svg: '<svg></svg>' };
});
vi.mock('mermaid', () => ({ default: { initialize, render } }));

const { renderMermaid } = await import('../src/mermaid.js');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('renderMermaid', () => {
  it('asks Mermaid not to draw its own error graphic', async () => {
    await renderMermaid('graph TD; a-->b');
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ suppressErrorRendering: true }));
  });

  it('rejects with the reason and leaves nothing behind in the page', async () => {
    await expect(renderMermaid('bar\n  x-axis [1, 2]')).rejects.toThrow(/Parse error/);
    expect(document.body.textContent).not.toContain('Syntax error');
  });
});
