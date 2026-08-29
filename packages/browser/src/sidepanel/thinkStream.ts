/**
 * Pulling thinking out of a stream that mixes it into the answer.
 *
 * There are two ways a model tells you it is thinking. The good one is a
 * separate field on the wire — `reasoning_content`, `reasoning` — which core
 * already recognises and reports as its own event; nothing here is involved.
 *
 * The other is `<think>…</think>` inline in the ordinary content, which is what
 * most locally-run reasoning models do. Core cannot separate that, because at
 * the provider layer it is indistinguishable from a model that happens to be
 * writing about XML. Left alone it lands in the narration, and the panel shows
 * the model's private deliberation as though it were speaking to the user —
 * paragraphs of "wait, let me reconsider" in the transcript, which is the bleed.
 *
 * So it is split here, at the point where narration becomes something a person
 * reads. The parser is a state machine over a stream because the tag arrives in
 * pieces: `<th` at the end of one delta and `ink>` at the start of the next is
 * ordinary, and a naive `replace` on each chunk never sees either.
 */

const OPEN = '<think>';
const CLOSE = '</think>';

export interface Split {
  /** Narration, for the transcript. */
  text: string;
  /** Deliberation, for the thinking block. */
  reasoning: string;
}

/**
 * A splitter for one message's stream.
 *
 * Holds back any trailing fragment that could still turn out to be a tag, so a
 * chunk ending in `<thi` emits nothing for those four characters and prepends
 * them to the next chunk. The held fragment is flushed by `end()`, which is
 * what stops a message that genuinely ends in `<` from losing its last
 * character.
 */
export class ThinkSplitter {
  #inside = false;
  /** Characters withheld because they may be the start of a tag. */
  #held = '';

  push(chunk: string): Split {
    let buffer = this.#held + chunk;
    this.#held = '';

    let text = '';
    let reasoning = '';

    while (buffer.length > 0) {
      const marker = this.#inside ? CLOSE : OPEN;
      const at = buffer.indexOf(marker);

      if (at >= 0) {
        const before = buffer.slice(0, at);
        if (this.#inside) reasoning += before;
        else text += before;
        this.#inside = !this.#inside;
        buffer = buffer.slice(at + marker.length);
        continue;
      }

      // No complete marker. Emit everything that cannot be the start of one,
      // and hold back the tail that still could be.
      const keep = partialMarkerLength(buffer, marker);
      const emit = keep > 0 ? buffer.slice(0, buffer.length - keep) : buffer;
      if (this.#inside) reasoning += emit;
      else text += emit;
      this.#held = keep > 0 ? buffer.slice(buffer.length - keep) : '';
      break;
    }

    return { text, reasoning };
  }

  /** Flush whatever was held back. Call when the message ends. */
  end(): Split {
    const held = this.#held;
    this.#held = '';
    // An unclosed `<think>` means the model never came back out of it. Its
    // content is deliberation, not an answer, and promoting it to narration on
    // a technicality is the bleed all over again.
    return this.#inside ? { text: '', reasoning: held } : { text: held, reasoning: '' };
  }

  get thinking(): boolean {
    return this.#inside;
  }
}

/**
 * How many trailing characters of `text` could be the beginning of `marker`.
 *
 * Longest first, so `<think` prefers holding six characters over holding one.
 */
function partialMarkerLength(text: string, marker: string): number {
  const most = Math.min(text.length, marker.length - 1);
  for (let length = most; length > 0; length--) {
    if (marker.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}
