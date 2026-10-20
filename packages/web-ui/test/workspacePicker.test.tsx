// @vitest-environment jsdom
/**
 * The folder chip. Heap Chat works without a folder, so it passes `onClear`
 * and gets a way back to none; Heap Code's agent has nothing to do outside a
 * folder, so it does not, and must not grow the row.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspacePicker } from '../src/components/WorkspacePicker.js';

afterEach(cleanup);

const loadWorkspaces = () =>
  Promise.resolve({ home: '/Users/me', recent: [{ path: '/Users/me/Documents', name: 'Documents' }] } as never);
const browse = () => Promise.resolve({ path: '/Users/me', entries: [] } as never);

async function openPicker(): Promise<void> {
  await act(async () => void fireEvent.click(screen.getByRole('button', { expanded: false })));
}

describe('WorkspacePicker', () => {
  it('offers no "No folder" row without onClear', async () => {
    render(
      <WorkspacePicker current="/Users/me/Documents" busy={false} loadWorkspaces={loadWorkspaces} browse={browse} onPick={vi.fn()} />,
    );
    await openPicker();
    expect(screen.queryByText('No folder')).toBeNull();
  });

  it('closes the folder through onClear, not onPick', async () => {
    const onPick = vi.fn(() => Promise.resolve());
    const onClear = vi.fn(() => Promise.resolve());
    render(
      <WorkspacePicker
        current="/Users/me/Documents"
        busy={false}
        loadWorkspaces={loadWorkspaces}
        browse={browse}
        onPick={onPick}
        onClear={onClear}
      />,
    );
    await openPicker();
    await act(async () => void fireEvent.click(screen.getByText('No folder')));
    expect(onClear).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('names the empty state on the chip rather than showing a blank', () => {
    render(<WorkspacePicker current="" busy={false} loadWorkspaces={loadWorkspaces} browse={browse} onPick={vi.fn()} onClear={vi.fn()} />);
    expect(screen.getByRole('button').textContent).toContain('No folder');
  });
});
