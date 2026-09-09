// @vitest-environment jsdom
/**
 * The side panel resizes, in both products.
 *
 * Reported from a real session: the panel dragged to size in Heap Code and
 * not in Heap Chat. The drag had lived inline in one App component, so the
 * other simply did not have it — which is the failure mode a shared shell
 * exists to prevent, and it had no test to notice.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePanelWidth } from '../src/panelWidth.js';

beforeEach(() => {
  localStorage.clear();
  window.innerWidth = 1600;
});
afterEach(() => localStorage.clear());

/** One pointer-down on the splitter, then a move, then a release. */
function drag(startDrag: ReturnType<typeof usePanelWidth>['startDrag'], from: number, to: number): void {
  const splitter = document.createElement('div');
  const panel = document.createElement('div');
  panel.className = 'panel';
  const parent = document.createElement('div');
  parent.append(splitter, panel);
  document.body.append(parent);
  Object.defineProperty(panel, 'clientWidth', { value: 500, configurable: true });

  act(() =>
    startDrag({
      preventDefault: () => undefined,
      currentTarget: Object.assign(splitter, { setPointerCapture: () => undefined }),
      clientX: from,
      pointerId: 1,
    } as never),
  );
  act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: to })));
  act(() => void window.dispatchEvent(new Event('pointerup')));
}

describe('usePanelWidth', () => {
  it('widens as the splitter is dragged left, and remembers it', () => {
    const { result } = renderHook(() => usePanelWidth('test.panelWidth'));
    expect(result.current.width).toBeUndefined(); // stylesheet default until dragged

    drag(result.current.startDrag, 900, 800);
    expect(result.current.width).toBe(600);
    expect(localStorage.getItem('test.panelWidth')).toBe('600');
  });

  it('comes back to the width it was left at', () => {
    localStorage.setItem('test.panelWidth', '742');
    expect(renderHook(() => usePanelWidth('test.panelWidth')).result.current.width).toBe(742);
  });

  it('keeps each product’s width apart', () => {
    localStorage.setItem('heapcode.panelWidth', '700');
    localStorage.setItem('heapchat.panelWidth', '420');
    expect(renderHook(() => usePanelWidth('heapcode.panelWidth')).result.current.width).toBe(700);
    expect(renderHook(() => usePanelWidth('heapchat.panelWidth')).result.current.width).toBe(420);
  });

  it('will not shrink below what the panel needs to show anything', () => {
    const { result } = renderHook(() => usePanelWidth('test.panelWidth'));
    drag(result.current.startDrag, 900, 1500);
    expect(result.current.width).toBe(320);
  });

  it('will not squeeze the transcript below its floor', () => {
    window.innerWidth = 1000;
    const { result } = renderHook(() => usePanelWidth('test.panelWidth'));
    // Asked for 900; the window only affords 1000 - 480.
    drag(result.current.startDrag, 900, 500);
    expect(result.current.width).toBe(520);
  });

  it('re-clamps a remembered width when the window is made smaller', () => {
    localStorage.setItem('test.panelWidth', '880');
    const { result } = renderHook(() => usePanelWidth('test.panelWidth'));
    expect(result.current.width).toBe(880);

    act(() => {
      window.innerWidth = 900;
      window.dispatchEvent(new Event('resize'));
    });
    // 900 - 480 = 420, which is above the 320 floor, so that is the width.
    expect(result.current.width).toBe(420);
  });
});
