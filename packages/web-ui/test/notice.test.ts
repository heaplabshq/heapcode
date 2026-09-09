// @vitest-environment jsdom
/**
 * The notice strip clears itself.
 *
 * Reported twice from a real session: "Now working in pin-folder." stayed
 * above the conversation long after the folder had changed. Every notice this
 * app raises is a confirmation that something finished, so none of them should
 * outlive being read — but the behaviour had no test, which is why the second
 * report could not be answered without going and looking at the code.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTICE_MS, useTransientNotice } from '../src/notice.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useTransientNotice', () => {
  it('shows a notice and clears it on its own', () => {
    const { result } = renderHook(() => useTransientNotice());

    act(() => result.current[1]('Now working in pin-folder.'));
    expect(result.current[0]).toBe('Now working in pin-folder.');

    act(() => vi.advanceTimersByTime(NOTICE_MS - 1));
    expect(result.current[0]).toBe('Now working in pin-folder.');

    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBeUndefined();
  });

  it('gives each new notice its own full clock', () => {
    const { result } = renderHook(() => useTransientNotice());

    act(() => result.current[1]('Stopping…'));
    act(() => vi.advanceTimersByTime(NOTICE_MS - 500));
    act(() => result.current[1]('Stopped.'));

    // The second notice must not inherit what was left of the first one's.
    act(() => vi.advanceTimersByTime(NOTICE_MS - 1));
    expect(result.current[0]).toBe('Stopped.');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current[0]).toBeUndefined();
  });

  it('restarts the clock when the SAME text is raised again', () => {
    // Keying the timer on the string alone did not re-run for a repeat, so the
    // second "Rebuilding the index…" inherited the remainder of the first.
    const { result } = renderHook(() => useTransientNotice());

    act(() => result.current[1]('Rebuilding the index…'));
    act(() => vi.advanceTimersByTime(NOTICE_MS - 100));
    act(() => result.current[1]('Rebuilding the index…'));

    act(() => vi.advanceTimersByTime(200));
    expect(result.current[0]).toBe('Rebuilding the index…');
  });

  it('still lets a click dismiss it early', () => {
    const { result } = renderHook(() => useTransientNotice());

    act(() => result.current[1]('Index rebuilt.'));
    act(() => result.current[1](undefined));
    expect(result.current[0]).toBeUndefined();

    // And clearing an already-clear notice schedules nothing to trip over.
    act(() => vi.advanceTimersByTime(NOTICE_MS * 2));
    expect(result.current[0]).toBeUndefined();
  });
});
