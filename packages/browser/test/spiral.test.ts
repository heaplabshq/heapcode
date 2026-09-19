import { describe, expect, it } from 'vitest';
import { SpiralWatch } from '../src/agent/repetition.js';

/**
 * Stopping a turn that has stopped going anywhere.
 *
 * Written from a real run. Asked to tick a label on a GitHub issue -- a
 * checkbox the snapshot had not offered, see test/hiddenControls.test.ts --
 * the model deliberated for pages, announced the call it was about to make a
 * dozen times, and then degenerated into two alternating lines repeated
 * hundreds of times. It never emitted a tool call, so the tool-call guard
 * never saw it; `maxTokens` was unset, so the provider never cut it off. The
 * only thing that ended it was the user pressing Stop.
 */

/** Feed text the way a stream does: in pieces that do not align with anything. */
function stream(watch: SpiralWatch, text: string, chunk = 17): boolean {
  let tripped = false;
  for (let i = 0; i < text.length; i += chunk) {
    if (watch.saw(text.slice(i, i + chunk))) tripped = true;
  }
  return tripped;
}

const REAL_TAIL = 'Hmm, ok.\n\nLet me write.\n\nHmm, ok.\n\nWriting.\n\n';

describe('a turn that has degenerated', () => {
  it('is caught on the shape the real run ended in', () => {
    expect(stream(new SpiralWatch(), REAL_TAIL.repeat(40))).toBe(true);
  });

  it('is caught through the whitespace drifting, as it did', () => {
    const drifting = ['Hmm, ok.\n\nWriting.\n', 'Hmm, ok.\n\nWriting.\n\n', 'Hmm, ok.\nWriting.\n'];
    let text = '';
    for (let i = 0; i < 40; i++) text += drifting[i % 3];
    expect(stream(new SpiralWatch(), text)).toBe(true);
  });

  it('reports once, not on every delta after it', () => {
    const watch = new SpiralWatch();
    const text = REAL_TAIL.repeat(40);
    let trips = 0;
    for (let i = 0; i < text.length; i += 17) if (watch.saw(text.slice(i, i + 17))) trips++;
    expect(trips).toBe(1);
  });

  it('says what happened in the user\'s terms, not the model\'s', () => {
    expect(new SpiralWatch().reason).toMatch(/repeating itself/i);
  });

  /**
   * The first version of this message added "this usually means it could not
   * find a control it was looking for". True of the run it was written from,
   * and wrong the very next time it fired -- that model was stuck on a page
   * that genuinely did not carry the delivery dates it wanted, and the message
   * sent the user looking for a missing button instead.
   */
  it('does not guess why', () => {
    expect(new SpiralWatch().reason).not.toMatch(/control/i);
    expect(new SpiralWatch().reason).toMatch(/ask again/i);
  });
});

describe('a turn that is merely long', () => {
  it('is left alone while the model is circling in substance but not in words', () => {
    // From the same real run, before it gave up. This is going round and round
    // and is still not what this catches: it is different text every time, and
    // deciding that it *means* the same thing is a judgement call nothing here
    // is qualified to make. The tool-call guard covers the version of this that
    // reaches the tools.
    const deliberating = [
      'Let me try typing into the filter field. Actually the "Filter labels" select is a combobox.',
      'Hmm, in GitHub\'s new label picker, each label row is a checkbox with a label. But here they are links.',
      'Wait, the earlier click on [129] navigated to the issues search. So these are actual links, not toggles.',
      'Let me reconsider: maybe the dialog is open and the rows are rendered as links with an href to the filter.',
      'Alternative approach: use the filter input to type "bug", then the list will filter, then click the checkbox.',
      'Let me re-read the page fully to see the dialog structure. The read_page showed the label list truncated.',
      'Actually, maybe I should try clicking on the text area instead. Or try double_click.',
      'Let me step back and think about what is happening here, because the handles do not line up.',
    ];
    expect(stream(new SpiralWatch(), deliberating.join('\n\n'))).toBe(false);
  });

  it('is left alone for repetition that is really a list', () => {
    let rows = '';
    for (let i = 0; i < 60; i++) rows += `| ThinkPad X1 Carbon Gen ${i} | 16GB | 1TB | 14 inch | In stock |\n`;
    expect(stream(new SpiralWatch(), rows)).toBe(false);
  });

  it('does not build a false repeat out of two different turns', () => {
    const watch = new SpiralWatch();
    stream(watch, REAL_TAIL.repeat(4));
    watch.turned();
    expect(stream(watch, REAL_TAIL.repeat(4))).toBe(false);
  });
});

/**
 * The half-hour before the repetition starts.
 *
 * The real run announced the call it was about to make a dozen times -- "let
 * me try clicking [277]", "FINAL: get_elements", "writing the call now" --
 * and only degenerated into two alternating lines at the very end. Catching
 * the announcing is catching it earlier, and on a signal that is a fact about
 * the turn rather than an opinion about its reasoning.
 */
const TOOLS = ['read_page', 'get_page_text', 'get_elements', 'extract_data', 'fetch_url', 'click', 'type', 'scroll'];

/** Enough deliberation to be past the point where naming tools means anything. */
function announcing(): string {
  const lines = [
    'Let me try get_page_text with find "Sept" to see if the dates render after all.',
    'Hmm, actually the search page may not show them. Let me reconsider the approach entirely.',
    'Alternative: get_elements with role link and filter "Collage Kit", then check each product.',
    'Wait. Maybe I should use fetch_url on the product pages instead, which is one call each.',
    'Hmm, but fetch_url has no session, so the delivery estimate may differ. Let me think again.',
    'OK. Decision: get_elements first. Writing the call now. Actually, let me reconsider once more.',
    'Let me do read_page and look at the truncated part. Hmm, that costs a turn. Ugh.',
    'FINAL: extract_data on the results. No wait -- that gave name and price only last time.',
  ];
  let text = '';
  while (text.length < 12_000) text += lines[(text.length / 97) % lines.length | 0] + '\n\n';
  return text;
}

describe('a turn that keeps announcing without acting', () => {
  it('is stopped, and says so without claiming to know why', () => {
    const watch = new SpiralWatch(TOOLS);
    expect(stream(watch, announcing())).toBe(true);
    expect(watch.reason).toMatch(/without doing it/i);
  });

  it('is left alone when the model names a tool and then calls it', () => {
    const watch = new SpiralWatch(TOOLS);
    // Six turns of thinking about a tool, calling it, thinking about the next.
    for (let i = 0; i < 6; i++) {
      stream(
        watch,
        'The list is virtualised, so read_page will only hold what is rendered. ' +
          'get_page_text with a find is the cheaper question here, and it is the one I want. ',
      );
      watch.turned();
    }
    expect(watch.saw('One more look with get_elements and I will have it.')).toBe(false);
  });

  /**
   * "Click" is what a model says about a page, not about its tools, and half
   * of every browsing turn contains it. Counting it would make the guard fire
   * on the runs that are working.
   */
  it('does not count tool names that are also ordinary words', () => {
    const watch = new SpiralWatch(TOOLS);
    let prose = '';
    for (let i = 0; prose.length < 12_000; i++) {
      prose +=
        `Result ${i}: I will click the filter, then click through to the item and type the ` +
        `postcode ${i}0001 into the delivery box. Clicking row ${i} scrolled the panel rather ` +
        `than selecting it, so the ${i}th attempt needs a different target. `;
    }
    expect(stream(watch, prose)).toBe(false);
  });

  it('needs a real span of text, not just the words', () => {
    const watch = new SpiralWatch(TOOLS);
    expect(
      stream(
        watch,
        'Options: read_page, get_page_text, get_elements, extract_data, fetch_url, ' +
          'read_page again, get_page_text again, get_elements again, extract_data again, fetch_url again.',
      ),
    ).toBe(false);
  });
});
