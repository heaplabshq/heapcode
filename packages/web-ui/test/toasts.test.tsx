// @vitest-environment jsdom
/**
 * A condition and an event are different things, and used to share a strip.
 *
 * "Exposed to your network" and "Disconnected" describe what the page IS: they
 * belong at the top and stay while they are true. "Could not locate that
 * message to edit" is over once it is read — but it sat in the same place,
 * looking like another thing wrong with the page, until something replaced it.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toasts } from '../src/components/Toasts.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Toasts', () => {
  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(<Toasts />);
    expect(container.firstChild).toBeNull();
  });

  it('clears an error on its own, without anyone dismissing it', () => {
    const dismiss = vi.fn();
    render(<Toasts error="Could not locate that message to edit." onDismissError={dismiss} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(10_000));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('gives a confirmation less time than an error', () => {
    // An error is worth reading twice; "Saved to notes.md" is not.
    const dismissNotice = vi.fn();
    const dismissError = vi.fn();
    render(
      <Toasts error="broke" onDismissError={dismissError} notice="Saved" onDismissNotice={dismissNotice} />,
    );
    act(() => void vi.advanceTimersByTime(6_000));
    expect(dismissNotice).toHaveBeenCalledTimes(1);
    expect(dismissError).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(4_000));
    expect(dismissError).toHaveBeenCalledTimes(1);
  });

  it('can be dismissed by clicking it', () => {
    const dismiss = vi.fn();
    render(<Toasts error="broke" onDismissError={dismiss} />);
    fireEvent.click(screen.getByRole('alert'));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('re-arms when the same message is raised again', () => {
    // Keyed on the text, so a second failure does not expire on the first
    // one's schedule.
    const dismiss = vi.fn();
    const { rerender } = render(<Toasts error="broke" onDismissError={dismiss} />);
    act(() => void vi.advanceTimersByTime(9_000));
    rerender(<Toasts error="broke again" onDismissError={dismiss} />);
    act(() => void vi.advanceTimersByTime(9_000));
    expect(dismiss).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1_500));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('announces an error as one, and a confirmation as a status', () => {
    render(<Toasts error="broke" notice="Saved" />);
    expect(screen.getByRole('alert').textContent).toBe('broke');
    expect(screen.getByRole('status').textContent).toBe('Saved');
  });
});
