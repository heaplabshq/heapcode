// @vitest-environment jsdom
/**
 * The donut on the composer and the breakdown behind it.
 *
 * These used to answer two different questions without saying so. The ring
 * showed the loop's live measurement, which after a run ends is a memory of
 * that run's peak; the modal recomputed what the NEXT turn would send. Tool
 * output is not carried between turns, so those two numbers are not close —
 * a run of forty file reads left the ring near half full and a breakdown
 * behind it reading 5%, with nothing anywhere to say they were measuring
 * different things.
 *
 * The ring is live only while a run is. Idle, it prices the next turn from
 * the same source the modal does, so the two agree; and the modal says which
 * of the two questions it is answering either way.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiContextResult } from '@heapcode/web-host/protocol';
import { ContextMeter } from '../src/components/ContextMeter.js';

afterEach(cleanup);

const BREAKDOWN: UiContextResult = {
  window: 32_000,
  compactionThreshold: 0.8,
  windowSource: 'profile',
  slices: [
    { key: 'system', label: 'System prompt', tokens: 1_200 },
    { key: 'tools', label: 'Tool definitions', tokens: 4_800, note: '18 tools offered.' },
    { key: 'instructions', label: 'Project instructions', tokens: 2_000 },
    { key: 'conversation', label: 'Conversation', tokens: 8_000 },
    { key: 'free', label: 'Free', tokens: 16_000 },
  ],
};

describe('ContextMeter', () => {
  it('shows the percentage of the window in use during a run', () => {
    render(
      <ContextMeter
        used={8_000}
        live
        window={32_000}
        load={() => Promise.resolve(BREAKDOWN)}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByText('25%')).toBeTruthy();
  });

  it('drops to what the next turn starts with once the run ends', async () => {
    // The bug this exists for: `used` holds the finished run's peak for as
    // long as the tab is open, and the context it measured has in fact been
    // released — the next turn starts from the breakdown's 16k, not 30k.
    const load = vi.fn(() => Promise.resolve(BREAKDOWN));
    render(<ContextMeter used={30_000} window={32_000} load={load} onOpenSettings={vi.fn()} />);
    expect(await screen.findByText('50%')).toBeTruthy();
  });

  it('does not price a hypothetical while a run is in flight', async () => {
    // Live, the loop's own figure is the true one and the host has better
    // things to do than rebuild a prompt nobody is going to send yet.
    const load = vi.fn(() => Promise.resolve(BREAKDOWN));
    render(<ContextMeter used={30_000} live window={32_000} load={load} onOpenSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('94%')).toBeTruthy());
    expect(load).not.toHaveBeenCalled();
  });

  it('re-prices when the conversation underneath it changes', async () => {
    const load = vi.fn(() => Promise.resolve(BREAKDOWN));
    const { rerender } = render(
      <ContextMeter used={0} revision={1} window={32_000} load={load} onOpenSettings={vi.fn()} />,
    );
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    rerender(<ContextMeter used={0} revision={2} window={32_000} load={load} onOpenSettings={vi.fn()} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('says which of the two questions the breakdown answers', async () => {
    // "5% of the window" beside a ring that said 47% was the whole confusion.
    render(
      <ContextMeter used={8_000} window={32_000} load={() => Promise.resolve(BREAKDOWN)} onOpenSettings={vi.fn()} />,
    );
    fireEvent.click(screen.getByLabelText('Context usage'));
    expect(await screen.findByText(/What the next turn starts with/)).toBeTruthy();
  });

  it('does not claim the free space is free while a run is spending it', async () => {
    // The host writes that note without knowing whether a run is in flight.
    // Mid-run the loop's tool results are eating exactly this space, and none
    // of them appear in the breakdown above it.
    render(
      <ContextMeter
        used={8_000}
        live
        window={32_000}
        load={() => Promise.resolve(BREAKDOWN)}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Context usage'));
    expect(await screen.findByText(/the run in flight is using part of it now/)).toBeTruthy();
  });

  it('renders nothing at all when the window size is unknown', () => {
    // A ring with no denominator is a made-up number.
    const { container } = render(
      <ContextMeter used={8_000} load={() => Promise.resolve(BREAKDOWN)} onOpenSettings={vi.fn()} />,
    );
    expect(container.querySelector('.ctx-btn')).toBeNull();
  });

  it('opens a modal that fetches the real breakdown', async () => {
    const load = vi.fn(() => Promise.resolve(BREAKDOWN));
    render(<ContextMeter used={8_000} window={32_000} load={load} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Context usage'));

    await waitFor(() => expect(load).toHaveBeenCalled());
    // Every consumer named, with its own number — the point of the screen.
    await screen.findByText('Tool definitions');
    expect(screen.getByText('4.8k')).toBeTruthy();
    expect(screen.getByText('18 tools offered.')).toBeTruthy();
    // The total is the slices minus free, not the ring's figure.
    expect(screen.getByText('16k / 32k tokens')).toBeTruthy();
    expect(screen.getByText(/compacts at 80%/)).toBeTruthy();
  });

  it('says the numbers are estimates rather than implying precision', async () => {
    render(
      <ContextMeter used={1} window={32_000} load={() => Promise.resolve(BREAKDOWN)} onOpenSettings={vi.fn()} />,
    );
    fireEvent.click(screen.getByLabelText('Context usage'));
    // Heap Code ships no tokenizer; presenting ~4-chars-per-token arithmetic as
    // exact would be the lie.
    expect(await screen.findByText(/roughly 4 characters per token/)).toBeTruthy();
  });

  it('surfaces a failure instead of an empty dialog', async () => {
    render(
      <ContextMeter
        used={1}
        window={32_000}
        load={() => Promise.reject(new Error('daemon is down'))}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText('Context usage'));
    expect(await screen.findByText('daemon is down')).toBeTruthy();
  });

  it('hands off to the profile editor, closing behind itself', async () => {
    const onOpenSettings = vi.fn();
    render(
      <ContextMeter
        used={1}
        window={32_000}
        load={() => Promise.resolve(BREAKDOWN)}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByLabelText('Context usage'));
    fireEvent.click(await screen.findByText(/Change the window size/));
    expect(onOpenSettings).toHaveBeenCalled();
    // Two stacked dialogs would bury the one it just opened.
    expect(screen.queryByText('Context window')).toBeNull();
  });
});
