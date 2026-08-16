// @vitest-environment jsdom
/**
 * The PR review gate.
 *
 * This is the one card in the app whose "yes" is irreversible and public — it
 * posts a comment on someone else's pull request under the user's GitHub
 * account. So the things worth pinning down are not cosmetic: that the preview
 * is actually shown before the decision, that focus lands on the safe option,
 * and that neither button fires anything until it is clicked.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewCard, type PendingReview } from '../src/components/Cards.js';

afterEach(cleanup);

const pending = (over: Partial<PendingReview> = {}): PendingReview => ({
  runId: 'r1',
  pr: { number: 42, url: 'https://github.com/acme/repo/pull/42', title: 'Add a thing' },
  preview: '## Review\n\n- `src/app.ts:12` — off-by-one in the loop bound',
  findingCount: 1,
  inlineCount: 1,
  plainText: false,
  resolve: vi.fn(),
  ...over,
});

describe('ReviewCard', () => {
  it('shows the full preview, not a summary of it', () => {
    render(<ReviewCard pending={pending()} />);
    expect(screen.getByText(/off-by-one in the loop bound/)).toBeTruthy();
  });

  it('says what will happen and where', () => {
    render(<ReviewCard pending={pending()} />);
    expect(screen.getByText(/Post this review on PR #42/)).toBeTruthy();
    expect(screen.getByText(/Posts publicly on GitHub/)).toBeTruthy();
  });

  it('focuses the safe option, so a stray Enter does not publish', () => {
    render(<ReviewCard pending={pending()} />);
    expect(document.activeElement?.textContent).toMatch(/Don.t post/);
  });

  it('resolves false on decline and true on post — and neither before a click', () => {
    const p = pending();
    render(<ReviewCard pending={p} />);
    expect(p.resolve).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(/Don.t post/));
    expect(p.resolve).toHaveBeenCalledWith(false);

    cleanup();
    const q = pending();
    render(<ReviewCard pending={q} />);
    fireEvent.click(screen.getByText('Post review'));
    expect(q.resolve).toHaveBeenCalledWith(true);
  });

  it('says so when the model produced no structured findings', () => {
    render(<ReviewCard pending={pending({ plainText: true, findingCount: 0, inlineCount: 0 })} />);
    expect(screen.getByText(/no structured findings/)).toBeTruthy();
    // And the button names what it will actually do — a comment, not a review.
    expect(screen.getByText('Post comment')).toBeTruthy();
  });
});
