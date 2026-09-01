import { describe, expect, it } from 'vitest';
import { BROWSER_AGENT_PROMPT } from '../src/agent/prompt.js';

/**
 * The prompt is the only place the model is told what it is. These assert the
 * properties that changed behaviour when they were missing, so a later edit
 * that drops one fails here rather than in a user's panel.
 *
 * (The sidepanel's own read-only prompt used to be asserted here too; it was
 * dead code — the sidepanel routes through BROWSER_AGENT_PROMPT — and its
 * injection-posture assertions folded into the block below.)
 */
describe('the agent prompt', () => {
  it('explains the handle notation the snapshot uses', () => {
    expect(BROWSER_AGENT_PROMPT).toMatch(/\[1\]/);
  });

  it('says the page is data and names the injection case explicitly', () => {
    expect(BROWSER_AGENT_PROMPT).toMatch(/never instructions/i);
    expect(BROWSER_AGENT_PROMPT).toMatch(/ignore your instructions/i);
    expect(BROWSER_AGENT_PROMPT).toMatch(/only the user's own messages/i);
  });

  it('tells the model to surface an injection attempt rather than silently ignoring it', () => {
    // A page that tried is worth knowing about; swallowing it hides an attack.
    expect(BROWSER_AGENT_PROMPT).toMatch(/mention it to them/i);
  });

  it('forbids inventing page content the tool results do not contain', () => {
    expect(BROWSER_AGENT_PROMPT).toMatch(/Never invent/);
  });

  it('prefers URL parameters over operating a filter panel', () => {
    // Observed: it spent a dozen turns fighting LinkedIn's all-filters dialog
    // after having already used the URL parameters successfully in an earlier
    // run. Filter panels open in dialogs and close when anything else is
    // clicked; a URL does neither.
    expect(BROWSER_AGENT_PROMPT).toMatch(/URL/);
    expect(BROWSER_AGENT_PROMPT).toMatch(/filter panels?/i);
  });

  it('explains why the page shrinks when a dialog opens', () => {
    expect(BROWSER_AGENT_PROMPT).toMatch(/dialog is open/i);
    expect(BROWSER_AGENT_PROMPT).toMatch(/inert/i);
  });

  it('tells it to ask rather than invent a value for a real form', () => {
    expect(BROWSER_AGENT_PROMPT).toMatch(/ask_user/);
    expect(BROWSER_AGENT_PROMPT).toMatch(/[Nn]ever invent/);
  });
});
