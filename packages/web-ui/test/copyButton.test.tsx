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
    render(<CopyButton text="x" />);
    await act(async () => void fireEvent.click(screen.getByRole('button')));
    expect(screen.getByRole('button').textContent).toBe('Copied');
    act(() => void vi.advanceTimersByTime(1_500));
    expect(screen.getByRole('button').textContent).toBe('Copy');
  });

  it('says so when the clipboard refuses, rather than looking like it worked', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    render(<CopyButton text="x" />);
    await act(async () => void fireEvent.click(screen.getByRole('button')));
    expect(screen.getByRole('button').textContent).toMatch(/Couldn.t copy/);
    // And the accessible name follows the label, so it is not announced as
    // "Copy" after a failure.
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Could not copy');
  });
});
