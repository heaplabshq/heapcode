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
