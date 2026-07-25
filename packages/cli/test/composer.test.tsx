import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/ink/Composer.js';

describe('Composer — multi-line input', () => {
  it('a trailing backslash before Enter inserts a newline instead of submitting', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<Composer onSubmit={onSubmit} />);
    await new Promise((r) => setTimeout(r, 20));

    stdin.write('first line\\');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('first line');

    stdin.write('second line');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('first line\nsecond line');
  });

  it('Option+Enter (ESC CR — also what /terminal-setup-style Shift+Enter bindings send) inserts a newline instead of submitting', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<Composer onSubmit={onSubmit} />);
    await new Promise((r) => setTimeout(r, 20));

    stdin.write('first line');
    stdin.write('\x1b\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('first line');

    stdin.write('second line');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('first line\nsecond line');
  });

  it('a long unbroken line is pre-wrapped to the terminal width instead of being handed to the terminal to wrap', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<Composer onSubmit={onSubmit} />);
    await new Promise((r) => setTimeout(r, 20));

    // ink-testing-library's fake stdout reports 100 columns; content width
    // is 100 minus the box/gutter overhead. 120 digits must therefore span
    // two rows, with no rendered row wider than the terminal.
    const longLine = Array.from({ length: 120 }, (_, i) => String(i % 10)).join('');
    stdin.write(longLine);
    await new Promise((r) => setTimeout(r, 20));

    const frame = lastFrame() ?? '';
    const rows = frame.split('\n');
    expect(rows.filter((l) => /\d/.test(l)).length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(100);

    // The buffer itself is untouched by display wrapping — submits as one line.
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(onSubmit).toHaveBeenCalledWith(longLine);
  });

  it('a multi-line paste (one stdin write containing embedded newlines) is inserted as literal text, not submitted line by line', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(<Composer onSubmit={onSubmit} />);
    await new Promise((r) => setTimeout(r, 20));

    stdin.write('function f() {\n  return 1;\n}');
    await new Promise((r) => setTimeout(r, 20));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('function f()');
    expect(lastFrame()).toContain('return 1;');

    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));
    expect(onSubmit).toHaveBeenCalledWith('function f() {\n  return 1;\n}');
  });

  it('Up/Down move within a multi-line buffer instead of jumping to history, until the first/last line', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Composer onSubmit={onSubmit} />);
    await new Promise((r) => setTimeout(r, 20));

    // A prior submission seeds history — proves Up doesn't touch it while
    // still inside multi-line content.
    stdin.write('earlier message');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));

    stdin.write('line one\\');
    stdin.write('\r');
    stdin.write('line two');
    await new Promise((r) => setTimeout(r, 20));
    // Cursor is at the end of "line two" (second/last line) — Up should
    // move to line one, not recall history.
    stdin.write('\x1b[A'); // up arrow
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('!');
    await new Promise((r) => setTimeout(r, 20));

    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));

    expect(onSubmit).toHaveBeenCalledTimes(2);
    // "!" landed at the end of "line one" (cursor was at end of that line's
    // column-equivalent position), never touched "earlier message".
    expect(onSubmit).toHaveBeenLastCalledWith('line one!\nline two');
  });

  it('Up still recalls history once the cursor is already on the buffer\'s first line', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<Composer onSubmit={onSubmit} />);
    await new Promise((r) => setTimeout(r, 20));

    stdin.write('earlier message');
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));

    stdin.write('hi');
    stdin.write('\x1b[A'); // single-line buffer — cursor is on (and only on) the first line
    await new Promise((r) => setTimeout(r, 20));
    stdin.write('\r');
    await new Promise((r) => setTimeout(r, 20));

    expect(onSubmit).toHaveBeenLastCalledWith('earlier message');
  });
});
