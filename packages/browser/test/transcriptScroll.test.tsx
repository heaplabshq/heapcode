// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { MessageList } from '../src/sidepanel/components/MessageList.js';
import type { Turn } from '../src/sidepanel/useChat.js';

/**
 * When the transcript follows, and when it leaves the view alone.
 *
 * Both halves are behaviours someone complained about. Following the stream
 * from anywhere yanks the page out from under a person reading back through
 * it; following it from nowhere means the message you just typed is the one
 * thing you cannot see after sending it, because reading the previous answer
 * is what scrolled you away from the bottom in the first place.
 *
 * jsdom has no layout, so every scroll measurement reads 0 and every position
 * looks like the bottom. The geometry is stubbed to put the transcript
 * somewhere in the middle, which is the state the bug needed.
 */

function scrolledUp() {
  const container = document.querySelector('.transcript') as HTMLElement;
  for (const [key, value] of [
    ['scrollHeight', 4000],
    ['scrollTop', 100],
    ['clientHeight', 600],
  ] as const) {
    Object.defineProperty(container, key, { value, configurable: true });
  }
  return container;
}

const user = (content: string): Turn => ({ role: 'user', content });
const assistant = (content: string, streaming = false): Turn => ({
  role: 'assistant',
  content,
  streaming,
  steps: [],
});

/** What `useChat` appends on a send: the question, and the reply to stream into. */
const sent = (question: string): Turn[] => [user(question), assistant('', true)];

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
});

afterEach(cleanup);

describe('the transcript after a send', () => {
  it('scrolls to the message, however far up the transcript was', () => {
    const answered = [user('what is on this page?'), assistant('A long answer.')];
    const view = render(<MessageList turns={answered} ready onRun={() => {}} />);
    scrolledUp();
    scrollIntoView.mockClear();

    view.rerender(<MessageList turns={[...answered, ...sent('and the price?')]} ready onRun={() => {}} />);

    expect(scrollIntoView).toHaveBeenCalled();
  });
});

describe('the transcript while a run is streaming', () => {
  it('leaves the view alone when the reader is not at the bottom', () => {
    const asked = [user('what is on this page?'), assistant('An answer so far', true)];
    const view = render(<MessageList turns={asked} ready onRun={() => {}} />);
    scrolledUp();
    scrollIntoView.mockClear();

    // The same turn, grown by another chunk -- no new question.
    view.rerender(
      <MessageList
        turns={[asked[0]!, assistant('An answer so far, and more of it', true)]}
        ready
        onRun={() => {}}
      />,
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('follows it when the reader is at the bottom', () => {
    const asked = [user('what is on this page?'), assistant('An answer so far', true)];
    const view = render(<MessageList turns={asked} ready onRun={() => {}} />);
    const container = scrolledUp();
    Object.defineProperty(container, 'scrollTop', { value: 3400, configurable: true });
    scrollIntoView.mockClear();

    view.rerender(
      <MessageList
        turns={[asked[0]!, assistant('An answer so far, and more of it', true)]}
        ready
        onRun={() => {}}
      />,
    );

    expect(scrollIntoView).toHaveBeenCalled();
  });
});
