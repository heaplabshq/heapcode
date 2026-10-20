import { describe, expect, it } from 'vitest';
import { clampListWidth, LIST_DEFAULT, LIST_MAX, LIST_MIN, savedListWidth } from '../src/layout.js';

describe('the note list width', () => {
  it('keeps a dragged width inside the list’s own range', () => {
    expect(clampListWidth(400, 1600)).toBe(400);
    expect(clampListWidth(80, 1600)).toBe(LIST_MIN);
    expect(clampListWidth(900, 1600)).toBe(LIST_MAX);
  });

  it('stops at the room the editor needs, not the list’s ceiling', () => {
    // 700 wide: the editor's 340 leaves 360 for the list.
    expect(clampListWidth(500, 700)).toBe(360);
  });

  it('gives the list its floor when the window cannot hold both', () => {
    expect(clampListWidth(400, 480)).toBe(LIST_MIN);
  });

  it('rounds a fractional drag', () => {
    expect(clampListWidth(320.6, 1600)).toBe(321);
  });

  it('resets to the default width', () => {
    expect(clampListWidth(LIST_DEFAULT, 1600)).toBe(LIST_DEFAULT);
  });

  it('reads a saved width back inside the list’s range', () => {
    expect(savedListWidth('420')).toBe(420);
    expect(savedListWidth('5000')).toBe(LIST_MAX);
    expect(savedListWidth('12')).toBe(LIST_MIN);
    expect(savedListWidth('wide')).toBe(LIST_DEFAULT);
    expect(savedListWidth(null)).toBe(LIST_DEFAULT);
  });
});
