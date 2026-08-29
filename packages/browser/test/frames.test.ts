import { describe, expect, it } from 'vitest';
import { bandOf, baseForBand, labelForFrame, mergeFrameSnapshots } from '../src/shared/frames.js';
import type { Control, PageSnapshot } from '../src/shared/snapshot.js';

/**
 * A frame gets to describe itself, and nothing else.
 *
 * The old arrangement had the top content script broadcast to every `<iframe>`
 * on the page over `postMessage` and merge whatever answered. In the case that
 * mattered -- a third-party advert frame whose origin was never granted -- our
 * content script was not in that frame at all, so the only thing that could
 * answer was the attacker's own page script. It could mint controls in any
 * band it liked, including another frame's, and a control it invented was
 * enough to be handed the user's saved details by `autofill_form`.
 *
 * The channel is gone (see `shared/frames.ts`). These cover the part that
 * survives: the merge, which now refuses to accept a frame's word about
 * handles outside the band that frame was given.
 */

function snapshot(controls: Control[], over: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://shop.example.com/',
    title: 'Shop',
    viewport: { width: 1000, height: 800, scrollY: 0, scrollHeight: 1000 },
    text: '',
    controls,
    tables: [],
    generation: 1,
    ...over,
  };
}

function control(handle: number, name: string): Control {
  return { handle, role: 'input', name, score: 100 };
}

describe('banding', () => {
  it('says which frame a handle belongs to', () => {
    expect(bandOf(3)).toBe(0);
    expect(bandOf(baseForBand(1) + 3)).toBe(1);
    expect(bandOf(baseForBand(2) + 3)).toBe(2);
  });
});

describe('merging a frame into the page', () => {
  it('keeps controls that stay inside the band the frame was given', () => {
    const merged = mergeFrameSnapshots(snapshot([control(1, 'Search')]), [
      {
        label: 'widget.example.com',
        band: 1,
        snapshot: snapshot([control(baseForBand(1) + 1, 'Accept')]),
      },
    ]);

    expect(merged.controls.map((c) => c.name)).toEqual(['Search', 'Accept']);
    expect(merged.controls[1]?.context).toContain('widget.example.com');
  });

  it('discards a control a frame minted in another frame band', () => {
    // The forgery that mattered: a frame answering with a handle that routes
    // somewhere it does not own. Nothing downstream can tell the difference
    // once it is in the list, so it never gets into the list.
    const merged = mergeFrameSnapshots(snapshot([control(1, 'Search')]), [
      {
        label: 'ads.evil.example',
        band: 1,
        snapshot: snapshot([
          control(baseForBand(1) + 1, 'Accept'),
          control(baseForBand(2) + 1, 'Email address'),
        ]),
      },
    ]);

    expect(merged.controls.map((c) => c.name)).toEqual(['Search', 'Accept']);
    expect(merged.notes?.join(' ')).toContain('outside the handles it was given');
  });

  it('discards a control a frame minted in the top document band', () => {
    // The sharpest version: band 0 is the page itself, so a forged handle there
    // would shadow -- or impersonate -- a control the user is actually looking at.
    const merged = mergeFrameSnapshots(snapshot([control(1, 'Search')]), [
      { label: 'ads.evil.example', band: 1, snapshot: snapshot([control(2, 'Email address')]) },
    ]);

    expect(merged.controls.map((c) => c.name)).toEqual(['Search']);
    expect(merged.notes?.join(' ')).toContain('outside the handles it was given');
  });

  it('reports a frame that did not answer, rather than dropping it silently', () => {
    // A frame we hold no permission for has no content script and never
    // replies. "The button is in a frame I cannot read" and "there is no
    // button" lead a model to different next moves.
    const merged = mergeFrameSnapshots(snapshot([control(1, 'Search')]), [
      { label: 'ads.evil.example', band: 1, snapshot: undefined },
    ]);

    expect(merged.notes?.join(' ')).toContain('could not be read');
  });

  it('ranks frame controls below the page’s own', () => {
    const merged = mergeFrameSnapshots(snapshot([control(1, 'Search')]), [
      {
        label: 'widget.example.com',
        band: 1,
        snapshot: snapshot([control(baseForBand(1) + 1, 'Accept')]),
      },
    ]);
    expect(merged.controls[1]!.score).toBeLessThan(merged.controls[0]!.score);
  });
});

describe('frame labels', () => {
  it('names a frame by its own host', () => {
    expect(labelForFrame('https://widget.example.com/embed?a=1')).toBe('widget.example.com');
  });

  it('falls back rather than throwing on an address it cannot parse', () => {
    expect(labelForFrame('about:blank')).toBe('embedded frame');
  });
});
