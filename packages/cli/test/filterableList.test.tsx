import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { FilterableList } from '../src/ink/FilterableList.js';

const ITEMS = [
  'openai/gpt-4o-mini',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'anthropic/claude-opus-4',
].map((value) => ({ label: value, value }));

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('FilterableList', () => {
  it('narrows on typed terms that are not contiguous in the id', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(<FilterableList items={ITEMS} onSelect={onSelect} />);
    await tick();
    expect(lastFrame()).toContain('anthropic/claude-opus-4');

    stdin.write('nvidia ultra');
    await tick();
    expect(lastFrame()).toContain('nvidia/nemotron-3-ultra-550b-a55b:free');
    expect(lastFrame()).not.toContain('anthropic/claude-opus-4');
    expect(lastFrame()).not.toContain('openai/gpt-4o-mini');
  });

  it('selects the highlighted row on Enter after filtering', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(<FilterableList items={ITEMS} onSelect={onSelect} />);
    await tick();
    stdin.write('nvidia ultra');
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith('nvidia/nemotron-3-ultra-550b-a55b:free');
  });

  it('backspace widens the list again', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(<FilterableList items={ITEMS} onSelect={onSelect} />);
    await tick();
    stdin.write('claude');
    await tick();
    expect(lastFrame()).not.toContain('openai/gpt-4o-mini');
    for (let i = 0; i < 6; i++) stdin.write('\x7f');
    await tick();
    expect(lastFrame()).toContain('openai/gpt-4o-mini');
  });

  it('says so when nothing matches, and Enter then selects nothing', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(<FilterableList items={ITEMS} onSelect={onSelect} />);
    await tick();
    stdin.write('zzzz');
    await tick();
    expect(lastFrame()).toContain('No matches.');
    stdin.write('\r');
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('runs the footer row instead of a selection when it is highlighted', async () => {
    const onSelect = vi.fn();
    const onFooter = vi.fn();
    const { stdin } = render(
      <FilterableList
        items={[ITEMS[0]!]}
        onSelect={onSelect}
        footer={{ label: 'Enter model name manually…', onSelect: onFooter }}
      />,
    );
    await tick();
    stdin.write('\x1B[B'); // down, past the single item onto the footer
    await tick();
    stdin.write('\r');
    await tick();
    expect(onFooter).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
