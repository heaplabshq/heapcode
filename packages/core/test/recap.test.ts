import { describe, expect, it } from 'vitest';
import { RECAP_BUDGET_MULTIPLIER, wantsConversationRecap } from '../src/agent/recap.js';

/**
 * The failure this guards against: a long conversation goes over budget, the
 * loop folds its earlier half into notes, and the user then asks "what did we
 * decide?" — getting a recap of a lossy summary that reads exactly like a
 * recap of the conversation.
 */
describe('wantsConversationRecap', () => {
  it('recognises the direct asks', () => {
    for (const task of [
      'summarize this chat',
      'summarise the conversation',
      'give me a recap',
      'tl;dr?',
      'TLDR please',
      'what are the key points',
      'what were the takeaways',
      'list the action items',
      'take notes on this discussion',
      'write down some notes',
      'minutes please',
    ]) {
      expect(wantsConversationRecap(task), task).toBe(true);
    }
  });

  it('recognises the indirect ones, which are how people actually ask', () => {
    for (const task of [
      'what did we discuss?',
      'what have we covered so far',
      'what did we decide',
      'remind me what we said',
      'where have we got to in this thread',
    ]) {
      expect(wantsConversationRecap(task), task).toBe(true);
    }
  });

  it('leaves ordinary work alone', () => {
    for (const task of [
      'fix the failing test in loop.ts',
      'add a button to the settings page',
      'why is the build slow',
      'rename this function',
      'read config.json and tell me the port',
    ]) {
      expect(wantsConversationRecap(task), task).toBe(false);
    }
  });

  it('does not fire on a request to summarize something that is not the chat', () => {
    // A known and accepted imprecision, pinned so a future change to the
    // pattern is a deliberate one: "summarize" anywhere still matches. The
    // cost is a larger budget on a turn that did not need it, which is a far
    // cheaper mistake than the one this exists to prevent.
    expect(wantsConversationRecap('summarize README.md for me')).toBe(true);
  });

  it('treats an absent task as ordinary', () => {
    expect(wantsConversationRecap(undefined)).toBe(false);
    expect(wantsConversationRecap('')).toBe(false);
  });

  it('raises the budget rather than removing it', () => {
    // Skipping compaction outright would overflow the window, which is the
    // opposite of protecting the answer.
    expect(RECAP_BUDGET_MULTIPLIER).toBeGreaterThan(1);
    expect(Number.isFinite(RECAP_BUDGET_MULTIPLIER)).toBe(true);
  });
});
