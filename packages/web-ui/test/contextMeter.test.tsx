// @vitest-environment jsdom
/**
 * The donut on the composer and the breakdown behind it.
 *
 * The number the ring shows is the last turn's reported usage; the modal
 * recomputes what the NEXT turn would send. They answer different questions and
 * will not always agree, which is fine — but the modal has to actually fetch
 * rather than reuse the ring's number, or "why is my context full" gets the
 * same unhelpful total it already had.
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
  it('shows the percentage of the window in use', () => {
    render(
      <ContextMeter used={8_000} window={32_000} load={() => Promise.resolve(BREAKDOWN)} onOpenSettings={vi.fn()} />,
    );
    expect(screen.getByText('25%')).toBeTruthy();
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
