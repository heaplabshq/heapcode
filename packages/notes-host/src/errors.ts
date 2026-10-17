/**
 * Every failure a command can report, by a code an agent can branch on.
 * Same shape as bearcli's: `{"error":{"code","message"}}`.
 */
export type NoteErrorCode =
  | 'not_found'
  | 'ambiguous'
  | 'conflict'
  | 'invalid_argument'
  | 'out_of_scope'
  | 'bad_front_matter'
  | 'exists'
  | 'io';

export class NoteError extends Error {
  constructor(
    readonly code: NoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NoteError';
  }

  toJSON(): { error: { code: NoteErrorCode; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}
