// @vitest-environment jsdom
/**
 * The webview half of the `ask_user` idle bound.
 *
 * The extension side is covered in packages/vscode/test/chatView.test.ts —
 * what the provider posts and when it resolves. None of that says anything
 * about the card the user actually looks at, and the card owns two things
 * nothing else can: it is the only source of the activity reports that push
 * the deadline back (chatViewProvider.ts:561-565), and it is the only place
 * "timed out" and "cancelled" are told apart for a human rather than for the
 * model.
 *
 * These run under jsdom because there is no way to assert on rendering or on
 * a focus event without a DOM. That is the one piece of test infrastructure
 * this file adds; everything else is the real App, driven exactly as the
 * extension drives it — `window.postMessage` in, `postToExtension` out.
 */
import type { ExtensionToWebview, WebviewToExtension } from '@heapcode/core';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Everything the webview sent to the extension, newest last. */
const posted: WebviewToExtension[] = [];

// vscodeApi.ts calls acquireVsCodeApi() at module load, so it has to exist
// before App is imported — hence the dynamic import below rather than a
// static one, which would be hoisted above this assignment.
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage(msg: unknown): void } }).acquireVsCodeApi =
  () => ({
    postMessage: (msg: unknown) => {
      posted.push(msg as WebviewToExtension);
    },
  });

// jsdom implements no element scrolling, and the transcript auto-scrolls on
// every new message (App.tsx:806-808).
Element.prototype.scrollTo = () => {};

const { App } = await import('../src/App.js');

/** Deliver an extension→webview message the way the webview host does. */
function emit(msg: ExtensionToWebview): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  });
}

const QUESTION_ID = 'q-1';

/** Render the app and put a question card on screen. */
function showQuestion(options?: string[]): void {
  render(<App />);
  emit({ type: 'agentQuestion', id: QUESTION_ID, question: 'Which database?', options });
}

function activityReports(): Array<Extract<WebviewToExtension, { type: 'agentQuestionActivity' }>> {
  return posted.filter(
    (p): p is Extract<WebviewToExtension, { type: 'agentQuestionActivity' }> =>
      p.type === 'agentQuestionActivity',
  );
}

function answerField(): HTMLElement | null {
  return screen.queryByPlaceholderText('Type an answer…');
}

beforeEach(() => {
  posted.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('the ask_user question card', () => {
  it('renders the question, and no countdown until one is posted', () => {
    showQuestion(['Postgres', 'SQLite']);

    expect(screen.getByText('Which database?')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Postgres' })).toBeDefined();
    // An unbounded question — the default — must not imply a deadline.
    expect(screen.queryByText(/the agent will carry on/)).toBeNull();
  });

  it('renders the countdown and actually counts down as the extension ticks it', () => {
    showQuestion();

    emit({ type: 'agentQuestionCountdown', id: QUESTION_ID, seconds: 18 });
    expect(screen.getByText(/no reply in 18s and the agent will carry on/)).toBeDefined();

    emit({ type: 'agentQuestionCountdown', id: QUESTION_ID, seconds: 9 });
    expect(screen.getByText(/no reply in 9s and the agent will carry on/)).toBeDefined();
    // The previous tick is replaced, not appended — one deadline, not a list.
    expect(screen.queryByText(/no reply in 18s/)).toBeNull();
  });

  it('ignores a countdown addressed to a different question', () => {
    showQuestion();

    emit({ type: 'agentQuestionCountdown', id: 'some-other-question', seconds: 7 });

    expect(screen.queryByText(/the agent will carry on/)).toBeNull();
  });

  /**
   * The behavior the report called critical: without these reports the
   * extension's deadline runs on schedule and a question can expire while the
   * user is still typing their answer into it.
   */
  describe('activity reporting', () => {
    it('reports every keystroke, carrying the answer so far as the partial', () => {
      showQuestion();

      fireEvent.change(answerField()!, { target: { value: 'Post' } });
      fireEvent.change(answerField()!, { target: { value: 'Postgre' } });

      expect(activityReports().map((p) => p.partial)).toEqual(['Post', 'Postgre']);
      expect(activityReports().every((p) => p.id === QUESTION_ID)).toBe(true);
    });

    it('reports the card regaining focus, so a user who came back is not cut off', () => {
      showQuestion();

      fireEvent.focus(answerField()!);

      expect(activityReports()).toHaveLength(1);
      expect(activityReports()[0]!.partial).toBe('');
    });

    it('stops reporting once the question is closed — there is nothing left to keep alive', () => {
      showQuestion();
      fireEvent.change(answerField()!, { target: { value: 'Post' } });

      emit({ type: 'agentQuestionClosed', id: QUESTION_ID, reason: 'idle' });

      // The input is gone, so no further activity can be reported at all.
      expect(answerField()).toBeNull();
      expect(activityReports()).toHaveLength(1);
    });
  });

  describe('a closed card', () => {
    it('shows a timed-out question as the agent having carried on, and stops taking input', () => {
      showQuestion(['Postgres', 'SQLite']);
      emit({ type: 'agentQuestionCountdown', id: QUESTION_ID, seconds: 3 });

      emit({ type: 'agentQuestionClosed', id: QUESTION_ID, reason: 'idle' });

      expect(screen.getByText(/No reply — the agent carried on with its own judgment\./)).toBeDefined();
      // Disabled, not merely stale: neither the options nor the free-text
      // answer can still be sent to a question that already resolved.
      expect(answerField()).toBeNull();
      expect(screen.queryByRole('button', { name: 'Postgres' })).toBeNull();
      // And the countdown is cleared rather than frozen at its last tick.
      expect(screen.queryByText(/the agent will carry on/)).toBeNull();
    });

    it('shows a cancelled question as cancelled, and stops taking input', () => {
      showQuestion(['Postgres', 'SQLite']);

      emit({ type: 'agentQuestionClosed', id: QUESTION_ID, reason: 'cancelled' });

      expect(screen.getByText(/Cancelled\./)).toBeDefined();
      expect(answerField()).toBeNull();
      expect(screen.queryByRole('button', { name: 'Postgres' })).toBeNull();
    });

    /**
     * The two closures must not look alike. "The agent is still working, on
     * its own judgment" and "your run stopped" call for opposite reactions
     * from the user, and the old hardcoded timeout rendered them identically.
     */
    it('renders the two closures differently', () => {
      showQuestion();
      emit({ type: 'agentQuestionClosed', id: QUESTION_ID, reason: 'idle' });
      const idleText = screen.getByText(/^↳/).textContent;

      cleanup();
      posted.length = 0;

      showQuestion();
      emit({ type: 'agentQuestionClosed', id: QUESTION_ID, reason: 'cancelled' });
      const cancelledText = screen.getByText(/^↳/).textContent;

      expect(idleText).not.toBe(cancelledText);
      expect(idleText).toMatch(/carried on/);
      expect(cancelledText).toMatch(/Cancelled/);
    });
  });

  it('answers on a click, and reports the answer once', () => {
    showQuestion(['Postgres', 'SQLite']);

    fireEvent.click(screen.getByRole('button', { name: 'SQLite' }));

    const answers = posted.filter((p) => p.type === 'agentQuestionResponse');
    expect(answers).toEqual([{ type: 'agentQuestionResponse', id: QUESTION_ID, answer: 'SQLite' }]);
    // Answered cards close too — no second answer for the same question.
    expect(answerField()).toBeNull();
  });
});
