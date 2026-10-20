import { describe, expect, it } from 'vitest';
import { Session, type HelloParams } from '../src/index.js';

const hello = (indexExclude?: string[]): HelloParams => ({
  token: 't',
  protocolVersion: 1,
  client: { name: 'test' },
  root: '/tmp/vault',
  profiles: [],
  activeProfile: 'none',
  roles: {},
  ...(indexExclude ? { indexExclude } : {}),
});

describe('paths a host says must never be indexed', () => {
  it('are known from hello, whatever the separators', () => {
    const s = new Session('s', hello(['Diary.md', 'private\\Plans.md', './x.md']));
    expect(s.isIndexExcluded('Diary.md')).toBe(true);
    expect(s.isIndexExcluded('private/Plans.md')).toBe(true);
    expect(s.isIndexExcluded('x.md')).toBe(true);
    expect(s.isIndexExcluded('Open.md')).toBe(false);
  });

  it('are replaced wholesale, not added to', () => {
    const s = new Session('s', hello(['A.md']));
    expect(s.setIndexExclude(['B.md'])).toEqual(['B.md']);
    expect(s.isIndexExcluded('A.md')).toBe(false);
    expect(s.isIndexExcluded('B.md')).toBe(true);
  });
});
