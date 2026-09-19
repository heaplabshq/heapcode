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
