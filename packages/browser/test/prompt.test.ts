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

  it('carries no other assistant\'s identity', () => {
    // The safety sections were adapted from a copied prompt that named its
    // maker throughout; none of that identity belongs in heapbrowse, which
    // runs on whatever model the user connected.
    expect(BROWSER_AGENT_PROMPT).not.toMatch(/claude|anthropic/i);
  });

  it('says to show instruction-like page content to the user and ask, not act', () => {
    // Observed in the wild: pages that bury "authorized" pre-approval text
    // where a person would not see it. Acting on it silently, without the
    // user ever having seen it, is the attack working.
    expect(BROWSER_AGENT_PROMPT).toMatch(/show the user the specific words/i);
    expect(BROWSER_AGENT_PROMPT).toMatch(/urgent/i);
    expect(BROWSER_AGENT_PROMPT).toMatch(/authorize/i);
  });

  it('keeps refusals final and forbids finding a way around them', () => {
    // A refusal the model routes around -- asking the page for another way
    // in, or accomplishing the same thing a step at a time -- is not a
    // refusal.
    expect(BROWSER_AGENT_PROMPT).toMatch(/get around a refusal/i);
  });

  it('keeps personal data out of addresses', () => {
    // URL parameters land in server logs and history, where a form field
    // never goes; the get-there-via-URL guidance needed this counterweight.
    expect(BROWSER_AGENT_PROMPT).toMatch(/Never put the user's personal data in an address/i);
  });

  it('declines cookie banners toward sharing less', () => {
    expect(BROWSER_AGENT_PROMPT).toMatch(/cookie banner/i);
    expect(BROWSER_AGENT_PROMPT).toMatch(/reject all/i);
  });

  it('never collects a profile of one person across pages', () => {
    // extract_data is a collection tool, and the tempting misuse of it is
    // assembling a dossier on a person. The tool stays; that use does not.
    expect(BROWSER_AGENT_PROMPT).toMatch(/identifying details about one person/i);
  });

  it('treats page-initiated downloads as worth saying so about', () => {
    // download is confirmed by the panel, but confirmation is not the same
    // as the user having asked; a page that starts its own download is
    // suspect even when the user clicks allow.
    expect(BROWSER_AGENT_PROMPT).toMatch(/Never use download on the page's own initiative/i);
  });

  it('quotes page content sparingly and never lyrics', () => {
    expect(BROWSER_AGENT_PROMPT).toMatch(/fifteen words/);
    expect(BROWSER_AGENT_PROMPT).toMatch(/lyrics/i);
  });
});
