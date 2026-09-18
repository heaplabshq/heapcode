import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '@heapcode/core';
import { toUiMessages } from '../src/session.js';
import { ATTACHMENT_PREFIX } from '../src/attachmentRoute.js';

/**
 * The transcript carries paths, never bytes: a conversation with ten
 * screenshots stays a small JSON and the browser fetches each picture once.
 */

const withImage: StoredMessage[] = [
  { role: 'user', content: 'look at this', images: ['att_abc.png'] } as StoredMessage,
  { role: 'assistant', content: 'I see it.' } as StoredMessage,
];

describe('attachment urls', () => {
  it('turns stored ids into paths the page can load', () => {
    const [user] = toUiMessages(withImage);
    expect(user?.images).toEqual([`${ATTACHMENT_PREFIX}att_abc.png`]);
  });

  it('carries the mount prefix for the mounted product', () => {
    // Chat is served under /chat; an unprefixed path would ask the root, and
    // the root is a different session.
    const [user] = toUiMessages(withImage, { attachmentBase: '/chat' });
    expect(user?.images).toEqual([`/chat${ATTACHMENT_PREFIX}att_abc.png`]);
  });

  it('never puts image bytes in the transcript', () => {
    const json = JSON.stringify(toUiMessages(withImage));
    expect(json).not.toContain('base64');
  });

  it('keeps a turn that was only a screenshot', () => {
    // No text to render, and dropping it would lose the image with it.
    const only = [{ role: 'user', content: '', images: ['att_abc.png'] } as StoredMessage];
    expect(toUiMessages(only)).toHaveLength(1);
  });

  it('leaves a turn with no images alone', () => {
    const plain = [{ role: 'user', content: 'no pictures' } as StoredMessage];
    expect(toUiMessages(plain)[0]?.images).toBeUndefined();
  });
});
