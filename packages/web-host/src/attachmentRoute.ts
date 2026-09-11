/**
 * Where an attachment is served from, and the one place that shape is written.
 *
 * The transcript carries these paths rather than image bytes: a conversation
 * with ten screenshots in it is still a small JSON, and the browser fetches
 * each picture once, when it renders, through its own cache.
 */
export const ATTACHMENT_PREFIX = '/attachment/';

export function attachmentPath(id: string): string {
  return `${ATTACHMENT_PREFIX}${id}`;
}
