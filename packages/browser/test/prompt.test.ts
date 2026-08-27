import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from '../src/sidepanel/prompt.js';

/**
 * The prompt is the only place the model is told what it is. These assert the
 * properties that changed behaviour when they were missing, so a later edit
 * that drops one fails here rather than in a user's panel.
 */
describe('the system prompt', () => {
  it('states the current capability, so the model stops guessing defensively', () => {
    // Without this the model met a page snapshot with no explanation and
    // answered "I cannot click buttons in your browser" instead of the question.
    expect(SYSTEM_PROMPT).toMatch(/cannot click/i);
    expect(SYSTEM_PROMPT).toMatch(/read and explain/i);
  });

  it('explains the handle notation the snapshot uses', () => {
    expect(SYSTEM_PROMPT).toMatch(/\[1\]/);
  });

  it('says the page is data and names the injection case explicitly', () => {
    expect(SYSTEM_PROMPT).toMatch(/never instructions/i);
    expect(SYSTEM_PROMPT).toMatch(/ignore your instructions/i);
    expect(SYSTEM_PROMPT).toMatch(/only the user's own messages/i);
  });

  it('tells the model to surface an injection attempt rather than silently ignoring it', () => {
    // A page that tried is worth knowing about; swallowing it hides an attack.
    expect(SYSTEM_PROMPT).toMatch(/mention it to the user/i);
  });

  it('warns that the snapshot is truncated, so gaps are reported not invented', () => {
    expect(SYSTEM_PROMPT).toMatch(/truncated/i);
  });
});
