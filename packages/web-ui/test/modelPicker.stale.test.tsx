// @vitest-environment jsdom
/**
 * The model list belongs to whichever connection is active.
 *
 * `ModelPicker` fetches once and keeps what it got — sensible, until the
 * connection underneath it changes. Switching provider left the previous
 * one's models in the menu until the page was reloaded, which is what a
 * reload does: it remounts the picker.
 *
 * So the picker is keyed on the connection in both Apps. This pins the two
 * halves of that: it really does cache, and remounting really does refetch.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../src/components/ModelPicker.js';

afterEach(cleanup);

/** Open the menu, which is what triggers the fetch. */
async function open(): Promise<void> {
  await act(async () => void fireEvent.click(screen.getAllByRole('button')[0]!));
}

/** The models on offer, as distinct from the current one on the button. */
function listed(): string[] {
  return [...document.querySelectorAll('.picker-item')].map((e) => e.textContent ?? '');
}

describe('ModelPicker', () => {
  it('fetches once and keeps the list while it is mounted', async () => {
    const listModels = vi.fn().mockResolvedValue([{ id: 'a-1' }]);
    render(<ModelPicker current="a-1" listModels={listModels} onPick={() => undefined} />);
    await open();
    await open();
    await open();
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('fetches again for a different connection, because the key remounts it', async () => {
    const listModels = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'from-first' }])
      .mockResolvedValueOnce([{ id: 'from-second' }]);

    const { rerender } = render(
      <ModelPicker key="first" current="from-first" listModels={listModels} onPick={() => undefined} />,
    );
    await open();
    expect(listed()).toEqual(['from-first']);

    rerender(<ModelPicker key="second" current="" listModels={listModels} onPick={() => undefined} />);
    await open();
    expect(listed()).toEqual(['from-second']);
  });

  it('retries after a failure, so a key added later is not stuck on the error', async () => {
    const listModels = vi
      .fn()
      .mockRejectedValueOnce(new Error('no key'))
      .mockResolvedValueOnce([{ id: 'now-works' }]);
    render(<ModelPicker current="" listModels={listModels} onPick={() => undefined} />);
    await open();
    expect(screen.getByText(/no key/)).toBeTruthy();
    await open();
    await open();
    expect(listed()).toEqual(['now-works']);
  });
});
