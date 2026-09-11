import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStore } from '../src/agent/attachments.js';

/**
 * Images used to be noted and discarded — `_(1 image attached)_` where the
 * screenshot had been — because conversations.json is read whole on every load
 * and a screenshot is megabytes of base64. The constraint was real; throwing
 * the picture away was not the only answer to it.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let dir: string;
let store: AttachmentStore;

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'att-')), 'attachments');
  store = new AttachmentStore(dir);
});

describe('storing an image', () => {
  it('returns an id and writes one file', async () => {
    const id = await store.put(PNG);
    expect(id).toMatch(/^att_[0-9a-f]{32}\.png$/);
    expect(await readdir(dir)).toEqual([id]);
  });

  it('stores the same picture once, however many turns carry it', async () => {
    const a = await store.put(PNG);
    const b = await store.put(PNG);
    expect(a).toBe(b);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('reads back the bytes and their type', async () => {
    const id = (await store.put(PNG))!;
    const found = await store.read(id);
    expect(found?.mediaType).toBe('image/png');
    // The PNG signature, so this is the file and not a truncation of it.
    expect([...found!.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('refuses anything that is not an image it can name', async () => {
    expect(await store.put('data:text/html;base64,PHNjcmlwdD4=')).toBeUndefined();
    expect(await store.put('https://example.com/x.png')).toBeUndefined();
    expect(await store.put('not a url at all')).toBeUndefined();
  });

  it('drops what it cannot store rather than failing the batch', async () => {
    expect(await store.putAll([PNG, 'data:text/html;base64,PHA+'])).toHaveLength(1);
  });
});

describe('reading one back', () => {
  it('will not be talked out of its own directory', async () => {
    // The id arrives from a URL. Joined blindly, `../` reads anything the
    // process can.
    await writeFile(join(dir, '..', 'secret.txt'), 'nope', 'utf8').catch(() => undefined);
    for (const id of ['../secret.txt', '..%2fsecret.txt', 'att_x.png', '/etc/passwd']) {
      expect(await store.read(id), id).toBeUndefined();
    }
  });

  it('treats a pruned attachment as a missing image, not a broken conversation', async () => {
    expect(await store.read('att_' + 'a'.repeat(32) + '.png')).toBeUndefined();
  });
});
