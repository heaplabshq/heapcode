// @vitest-environment jsdom
/**
 * The agent's question card.
 *
 * Both of these were reported from a real session. An `ask_user` option is a
 * sentence, and `.btn`'s `white-space: nowrap` — correct for Allow and Deny —
 * sent the longest one straight out through the side of the card. And the card
 * outlived its conversation: switching folder left a question about a repo you
 * were no longer in floating over an empty workspace, still clickable.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abandonCards,
  AskUserCard,
  type PendingAsk,
  type PendingPermission,
  type PendingReview,
} from '../src/components/Cards.js';

afterEach(cleanup);

const LONG =
  'Build a new standalone image-pinning tool in this repo (e.g. packages/image-pin) — ' +
  'sqlite db + CLI/web UI to pin images from any folder and reopen them';

const pending = (over: Partial<PendingAsk> = {}): PendingAsk => ({
  runId: 'r1',
  question: 'Where should the pin feature live?',
  resolve: vi.fn(),
  ...over,
});

describe('AskUserCard', () => {
  it('lets a long option wrap instead of running out of the card', () => {
    const { container } = render(
      <AskUserCard pending={pending({ options: [LONG, 'It belongs in a different repo'] })} />,
    );

    // The row layout is the bug: a flex item wider than its container
    // overflows rather than wrapping, so options get their own column.
    expect(container.querySelector('.card-options')).toBeTruthy();
    expect(container.querySelector('.card-actions')).toBeNull();

    const option = screen.getByText(LONG);
    expect(option.className).toContain('btn-option');
  });

  it('still answers with the option that was clicked', () => {
    const resolve = vi.fn();
    render(<AskUserCard pending={pending({ options: [LONG, 'Somewhere else'], resolve })} />);

    fireEvent.click(screen.getByText(LONG));
    expect(resolve).toHaveBeenCalledWith(LONG);
  });

  it('falls back to a free-text answer when the agent offered no options', () => {
    const resolve = vi.fn();
    const { container } = render(<AskUserCard pending={pending({ resolve })} />);

    const input = container.querySelector('.card-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'the second one' } });
    fireEvent.submit(container.querySelector('form')!);
    expect(resolve).toHaveBeenCalledWith('the second one');
  });
});

describe('abandoning the cards of a conversation that is gone', () => {
  it('answers nothing for the question, so the run is not left waiting', () => {
    // Every card is the browser half of an open RPC request. Hiding one
    // without settling it leaves the run waiting for a person who has walked
    // away. An empty answer is what the host reads as "the user did not
    // answer" and turns into "proceed with your best judgment".
    const ask = pending();
    abandonCards({ ask });
    expect(ask.resolve).toHaveBeenCalledWith('');
  });

  it('DENIES a permission rather than letting a switch grant it', () => {
    // The one that must never regress: closing a conversation cannot become a
    // way to allow something nobody looked at.
    const permission = {
      runId: 'r1',
      permission: 'write',
      description: 'Write src/app.ts',
      allowPersist: true,
      resolve: vi.fn(),
    } as unknown as PendingPermission;

    abandonCards({ permission });
    expect(permission.resolve).toHaveBeenCalledWith('deny');
    expect(permission.resolve).not.toHaveBeenCalledWith('allow');
    expect(permission.resolve).not.toHaveBeenCalledWith('session');
    expect(permission.resolve).not.toHaveBeenCalledWith('always');
  });

  it('refuses a review rather than publishing one nobody confirmed', () => {
    const review = { runId: 'r1', resolve: vi.fn() } as unknown as PendingReview;
    abandonCards({ review });
    expect(review.resolve).toHaveBeenCalledWith(false);
  });

  it('does nothing when no card is open', () => {
    expect(() => abandonCards({})).not.toThrow();
  });
});
