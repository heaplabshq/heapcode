/**
 * Notices a model stuck saying the same thing over and over.
 *
 * Small reasoning models in particular fall into a loop inside their own
 * thinking: one paragraph ("Wait, but `<Navbar />` doesn't have children. Let
 * me look at the Navbar component. Actually, the error is about…") produced
 * again and again until the reply runs out of tokens — minutes of output, all
 * of it paid for, none of it progress. Nothing about the request was wrong;
 * the sampling simply found a cycle and stayed in it.
 *
 * The test is deliberately blunt: does the last stretch of text already appear
 * at least twice in what came just before? A real loop repeats a long block
 * verbatim, so a long stretch is required — short repeats are normal (code,
 * lists, "Let me check…") and must never trip it. Whitespace is ignored, since
 * a loop sometimes varies only in line breaks.
 */
export interface RepetitionWatchOptions {
  /** How long a stretch must repeat, in characters (whitespace collapsed). */
  span?: number;
  /** How many earlier copies of it make a loop. */
  copies?: number;
  /** How far back to look. */
  window?: number;
  /** Check this often, in characters received. */
  every?: number;
}

export class RepetitionWatch {
  private text = '';
  private sinceCheck = 0;
  private readonly span: number;
  private readonly copies: number;
  private readonly window: number;
  private readonly every: number;

  constructor(options: RepetitionWatchOptions = {}) {
    this.span = options.span ?? 200;
    this.copies = options.copies ?? 2;
    this.window = options.window ?? 12_000;
    this.every = options.every ?? 200;
  }

  /** Add streamed text; true once it is looping. */
  push(chunk: string): boolean {
    this.text += chunk;
    this.sinceCheck += chunk.length;
    if (this.text.length > this.window * 2) this.text = this.text.slice(-this.window);
    if (this.sinceCheck < this.every) return false;
    this.sinceCheck = 0;
    return isLooping(this.text, this.span, this.copies, this.window);
  }
}

/** Whether the end of `text` repeats at least `copies` more times in the stretch before it. */
export function isLooping(text: string, span = 200, copies = 2, window = 12_000): boolean {
  const flat = text.slice(-window).replace(/\s+/g, ' ');
  if (flat.length < span * (copies + 1)) return false;
  const tail = flat.slice(-span);
  // Something that is mostly one character (a rule of dashes, a run of
  // spaces) repeats by its nature and is not a model going round in circles.
  if (new Set(tail).size < 12) return false;
  let found = 0;
  let from = flat.length - span - 1;
  while (from >= 0) {
    const at = flat.lastIndexOf(tail, from);
    if (at < 0) break;
    found += 1;
    if (found >= copies) return true;
    from = at - 1;
  }
  return false;
}

/** Thrown inside a streamed reply to stop it once it loops. */
export class RepetitionError extends Error {
  constructor(readonly where: 'reasoning' | 'text') {
    super(`The model started repeating itself (${where === 'reasoning' ? 'in its thinking' : 'in its reply'}).`);
    this.name = 'RepetitionError';
  }
}

/** Said to the model on the one retry after a loop. */
export const REPETITION_NUDGE =
  'Your previous reply got stuck repeating the same reasoning over and over, so it was stopped. ' +
  'Do not go back over that analysis. Take the next concrete step now: call a tool — read the file, ' +
  'run the check, make the edit — or, if you cannot make progress, finish and say what is blocking you.';

/** Shown in the transcript when that happens. */
export const REPETITION_NOTICE = 'The model started repeating itself, so heapcode stopped that reply and asked again.';
