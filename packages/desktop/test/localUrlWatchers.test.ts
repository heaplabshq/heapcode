import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createLocalUrlWatchers } = require('../src/localUrlWatchers.cjs') as typeof import('../src/localUrlWatchers.cjs');

/** A WebContents as far as the watchers can tell: an id and its events. */
function page(id: number): EventEmitter & { id: number } {
  return Object.assign(new EventEmitter(), { id });
}

const listenerCount = (p: EventEmitter): number =>
  p.listenerCount('destroyed') + p.listenerCount('did-start-navigation');

describe('local URL watchers', () => {
  it('a page asking again and again keeps one subscription — the leak Electron warned about', () => {
    const w = createLocalUrlWatchers();
    const p = page(1);
    const push = vi.fn();
    for (let i = 0; i < 20; i++) w.watch(p, push);

    expect(w.size()).toBe(1);
    expect(listenerCount(p)).toBe(2);
    w.notify(['http://localhost:5173/']);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('a real navigation unsubscribes and removes every listener it added', () => {
    const w = createLocalUrlWatchers();
    const p = page(1);
    w.watch(p, vi.fn());
    p.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });

    expect(w.size()).toBe(0);
    expect(listenerCount(p)).toBe(0);
  });

  it('reloads many times without piling listeners up', () => {
    const w = createLocalUrlWatchers();
    const p = page(1);
    for (let i = 0; i < 20; i++) {
      w.watch(p, vi.fn());
      p.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    }
    w.watch(p, vi.fn());
    expect(listenerCount(p)).toBe(2);
  });

  it('in-page routing and subframes are not a navigation away', () => {
    const w = createLocalUrlWatchers();
    const p = page(1);
    w.watch(p, vi.fn());
    p.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    p.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(w.size()).toBe(1);
  });

  it('a closed page is forgotten', () => {
    const w = createLocalUrlWatchers();
    const p = page(1);
    w.watch(p, vi.fn());
    p.emit('destroyed');
    expect(w.size()).toBe(0);
    expect(listenerCount(p)).toBe(0);
  });

  it('each page hears about new addresses', () => {
    const w = createLocalUrlWatchers();
    const a = vi.fn();
    const b = vi.fn();
    w.watch(page(1), a);
    w.watch(page(2), b);
    w.notify(['http://localhost:5179/']);
    expect(a).toHaveBeenCalledWith(['http://localhost:5179/']);
    expect(b).toHaveBeenCalledWith(['http://localhost:5179/']);
  });
});
