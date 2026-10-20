// @vitest-environment jsdom
/**
 * The splitter is the only way to give the open note more room, so the drag
 * itself is what is tested here — not just the clamp it calls.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListSplitter } from '../src/ListSplitter.js';
import { LIST_DEFAULT, LIST_MAX, LIST_MIN } from '../src/layout.js';

afterEach(cleanup);

/** jsdom has no pointer capture; the splitter only needs it to not throw. */
const stubCapture = () => {
  const el = screen.getByRole('separator');
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn(() => true);
  return el;
};

/** A controlled harness, as App is: the width it renders is the one it was given. */
function Harness({
  initial,
  mainWidth,
  onResize,
  onCommit,
}: {
  initial: number;
  mainWidth: number;
  onResize(w: number): void;
  onCommit(w: number): void;
}): JSX.Element {
  const [width, setWidth] = useState(initial);
  return (
    <ListSplitter
      width={width}
      getMainWidth={() => mainWidth}
      onResize={(w) => {
        setWidth(w);
        onResize(w);
      }}
      onCommit={onCommit}
    />
  );
}

const setup = (width = LIST_DEFAULT, mainWidth = 1600) => {
  const onResize = vi.fn();
  const onCommit = vi.fn();
  const { unmount } = render(
    <Harness initial={width} mainWidth={mainWidth} onResize={onResize} onCommit={onCommit} />,
  );
  return { onResize, onCommit, unmount, el: stubCapture() };
};

describe('the note list splitter', () => {
  it('widens the list as the pointer moves right', () => {
    const { onResize, el } = setup(300);
    fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 560, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(360);
  });

  it('narrows it as the pointer moves left', () => {
    const { onResize, el } = setup(300);
    fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 440, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(240);
  });

  it('stops at the list’s floor however far left the drag goes', () => {
    const { onResize, el } = setup(300);
    fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 0, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(LIST_MIN);
  });

  it('stops at the list’s ceiling however far right the drag goes', () => {
    const { onResize, el } = setup(300);
    fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 5000, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(LIST_MAX);
  });

  it('stops short of the editor’s floor on a narrow window', () => {
    const { onResize, el } = setup(300, 700);
    fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 5000, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(360);
  });

  it('ignores a move that never started with a press', () => {
    const { onResize, el } = setup(300);
    fireEvent.pointerMove(el, { clientX: 900, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('ignores a right-click', () => {
    const { onResize, el } = setup(300);
    fireEvent.pointerDown(el, { button: 2, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 900, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('stops following the pointer once released', () => {
    const { onResize, el } = setup(300);
    fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 500, pointerId: 1 });
    onResize.mockClear();
    fireEvent.pointerMove(el, { clientX: 900, pointerId: 1 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('marks the page as resizing while the drag is live', () => {
    const { el } = setup(300);
    fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 });
    expect(document.body.classList.contains('notes-resizing')).toBe(true);
    fireEvent.pointerUp(el, { clientX: 500, pointerId: 1 });
    expect(document.body.classList.contains('notes-resizing')).toBe(false);
  });

  it('saves the width once the drag ends, not on every move', () => {
    const { onResize, onCommit, el } = setup(300);
    fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 520, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 560, pointerId: 1 });
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(el, { clientX: 560, pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(360);
  });

  it('saves the reset and the arrow-key width too', () => {
    const { onCommit, el } = setup(480);
    fireEvent.doubleClick(el);
    expect(onCommit).toHaveBeenLastCalledWith(LIST_DEFAULT);
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenLastCalledWith(LIST_DEFAULT + 16);
  });

  it('clears the resizing class if the panes are hidden mid-drag', () => {
    const { el, unmount } = setup(300);
    fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 });
    expect(document.body.classList.contains('notes-resizing')).toBe(true);
    // ⌃1 unmounts the splitter before the pointer is ever released.
    unmount();
    expect(document.body.classList.contains('notes-resizing')).toBe(false);
  });

  it('resets to the default width on a double-click', () => {
    const { onResize, el } = setup(480);
    fireEvent.doubleClick(el);
    expect(onResize).toHaveBeenLastCalledWith(LIST_DEFAULT);
  });

  it('moves 16px per arrow key, and ignores other keys', () => {
    const { onResize, el } = setup(300);
    fireEvent.keyDown(el, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(316);
    fireEvent.keyDown(el, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(300);
    onResize.mockClear();
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('reads the room at drag time, so a window resize since render still counts', () => {
    let mainWidth = 1600;
    const onResize = vi.fn();
    render(
      <ListSplitter
        width={300}
        getMainWidth={() => mainWidth}
        onResize={onResize}
        onCommit={vi.fn()}
      />,
    );
    const el = stubCapture();
    // The window shrank after the splitter rendered.
    mainWidth = 700;
    fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 5000, pointerId: 1 });
    expect(onResize).toHaveBeenLastCalledWith(360);
  });

  it('reports its width to assistive tech', () => {
    const { el } = setup(420);
    expect(el.getAttribute('aria-valuenow')).toBe('420');
    expect(el.getAttribute('aria-valuemin')).toBe(String(LIST_MIN));
    expect(el.getAttribute('aria-valuemax')).toBe(String(LIST_MAX));
  });
});
