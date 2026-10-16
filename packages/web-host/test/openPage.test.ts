import { describe, expect, it } from 'vitest';
import { openPageRequest } from '../src/openFile.js';

describe('openPageRequest', () => {
  it('refuses a page reached over the network — it would open on this computer, not theirs', async () => {
    await expect(openPageRequest({ title: 't', html: '<p>x</p>' }, true, 'Heap Code')).rejects.toThrow(/over the network/);
  });
  it('refuses nothing to open, and anything absurdly large', async () => {
    await expect(openPageRequest({ title: 't' }, false, 'Heap Code')).rejects.toThrow(/Nothing to open/);
    await expect(openPageRequest({ title: 't', html: 'x'.repeat(20_000_001) }, false, 'Heap Code')).rejects.toThrow(/too large/);
  });
});
