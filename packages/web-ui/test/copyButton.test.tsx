// @vitest-environment jsdom
/**
 * A copy button under every reply, in all four surfaces. The two things worth
 * pinning are that it copies the *source* — the markdown the model wrote, not
 * the rendered HTML someone would have to strip by hand — and that a refused
 * clipboard says so rather than looking like it worked.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../src/components/CopyButton.js';

let written: string[];

beforeEach(() => {
  vi.useFakeTimers();
  written = [];
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CopyButton', () => {
  it('copies the markdown source, not rendered output', async () => {
    render(<CopyButton text={'Use `npm ci`\n\n- one\n- two'} />);
    await act(async () => void fireEvent.click(screen.getByRole('button')));
    expect(written).toEqual(['Use `npm ci`\n\n- one\n- two']);
  });

  it('confirms, then goes back to offering', async () => {
    // The label is a glyph, so the accessible name is what carries the state —
    // and what a tooltip and a screen reader both read.
    render(<CopyButton text="x" />);
    await act(async () => void fireEvent.click(screen.getByRole('button')));
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Copied');
    act(() => void vi.advanceTimersByTime(1_500));
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Copy');
  });

  it('is an icon, not a word', () => {
    render(<CopyButton text="x" />);
    const button = screen.getByRole('button');
    expect(button.querySelector('svg')).toBeTruthy();
    expect(button.textContent).toBe('');
    // Which makes the name the only thing saying what it does.
    expect(button.getAttribute('aria-label')).toBe('Copy');
    expect(button.getAttribute('title')).toBe('Copy');
  });

  it('says so when the clipboard refuses, rather than looking like it worked', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    render(<CopyButton text="x" />);
    await act(async () => void fireEvent.click(screen.getByRole('button')));
    // Nothing visible says so but the glyph, so the name has to.
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Could not copy');
    expect(screen.getByRole('button').getAttribute('title')).toMatch(/refused clipboard access/);
  });
});
