import type { PageSnapshot } from './snapshot.js';

/**
 * Embedded frames, and how their controls are addressed.
 *
 * Handles are banded by frame so the number itself says where to route: handle
 * 3 is the top document's, handle 200_003 belongs to the second frame. That
 * part was always right. What was wrong was who did the asking.
 *
 * The top content script used to gather its children over `postMessage`,
 * broadcasting to every `<iframe>` on the page with `targetOrigin: '*'` and
 * merging whatever came back. A frame's reply was authenticated only by
 * `event.source`, which any script running *in that frame* satisfies -- and in
 * the case that matters it is the only thing running there, because a
 * third-party advert frame's origin was never granted and our content script
 * was never injected into it. So a hostile frame could answer for itself:
 * invent controls, hand them any flags it liked, and receive the user's saved
 * details when `autofill_form` matched the field it had just made up.
 *
 * There is no fixing that channel. A page script in a frame is indistinguishable
 * from our content script in that frame, because `postMessage` proves only
 * which window spoke. So the traffic moved off it: the panel now addresses each
 * frame directly with `chrome.tabs.sendMessage(..., { frameId })`, which Chrome
 * delivers only to our own content script and which no page script can answer,
 * observe, or intercept. Frames we hold no permission for have no content
 * script, never reply, and are reported as unread -- which is what they always
 * should have been.
 *
 * This module is the part that has no privileges: the banding arithmetic and
 * the merge, kept pure so both can be tested without a browser.
 */

/**
 * Handles per frame.
 *
 * Deliberately far larger than any page's control count, so a long-lived page
 * cannot count its way into the next frame's band.
 */
export const FRAME_BAND = 100_000;

/** The band a frame's handles live in. Band 0 is the top document. */
export function baseForBand(band: number): number {
  return band * FRAME_BAND;
}

/** Which band a handle belongs to. */
export function bandOf(handle: number): number {
  return Math.floor(handle / FRAME_BAND);
}

/** One frame's contribution to the page, or its absence. */
export interface FramePart {
  /** What to call it in the model's context line. */
  label: string;
  band: number;
  snapshot?: PageSnapshot;
}

/**
 * The top document plus everything embedded in it, as one page.
 *
 * A frame that did not answer is named in the notes rather than dropped: "the
 * accept button is in a frame I cannot read" and "there is no accept button"
 * lead a model to completely different next moves.
 */
export function mergeFrameSnapshots(base: PageSnapshot, parts: FramePart[]): PageSnapshot {
  if (parts.length === 0) return base;

  const notes: string[] = [...(base.notes ?? [])];
  const controls = [...base.controls];
  const tables = [...base.tables];
  const texts = [base.text];

  for (const part of parts) {
    const inner = part.snapshot;
    if (!inner) {
      notes.push(
        `An embedded frame ("${part.label}") could not be read. Its content is not in this ` +
          `snapshot; if what you are looking for should be inside it, say so rather than ` +
          `assuming it is absent.`,
      );
      continue;
    }
    if (inner.controls.length === 0 && !inner.text.trim()) continue;

    // Every handle a frame reports has to fall inside the band that frame was
    // given. A frame cannot be trusted to stay in its lane -- it is a separate
    // document, and on the old channel it was not even necessarily ours -- and
    // a handle outside the band routes an action to a different frame than the
    // one the confirmation described.
    const low = baseForBand(part.band);
    const high = low + FRAME_BAND;
    const inBand = inner.controls.filter(
      (control) => control.handle > low && control.handle < high,
    );
    if (inBand.length !== inner.controls.length) {
      notes.push(
        `An embedded frame ("${part.label}") reported controls outside the handles it was ` +
          `given; those were discarded.`,
      );
    }

    controls.push(
      ...inBand.map((control) => ({
        ...control,
        context: control.context ? `${part.label}: ${control.context}` : `in frame "${part.label}"`,
        // Frame content ranks just below the host page: it is usually a consent
        // dialog or a payment field, which matters, but the page's own controls
        // are what the user is looking at.
        score: Math.max(0, control.score - 50),
      })),
    );
    tables.push(...inner.tables);
    if (inner.text.trim()) texts.push(`[frame "${part.label}"]\n${inner.text.trim()}`);
    if (inner.notes?.length) notes.push(...inner.notes);
  }

  return {
    ...base,
    controls,
    tables,
    text: texts.filter(Boolean).join('\n\n'),
    notes: notes.length > 0 ? notes : undefined,
  };
}

/** A readable name for a frame, from its own address. */
export function labelForFrame(url: string): string {
  try {
    return new URL(url).host || 'embedded frame';
  } catch {
    return 'embedded frame';
  }
}
