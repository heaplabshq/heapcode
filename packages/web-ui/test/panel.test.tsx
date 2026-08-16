// @vitest-environment jsdom
/**
 * The Changes tab, and the workspace button that opens it.
 *
 * Both were reshaped for the same reason: a real session accumulates a dozen
 * checkpoints, and the old layout let them bury the changed files — the thing
 * the tab is about — under a wall of identical buttons.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiCheckpoint, UiChangedFile } from '@heapcode/web-host/protocol';
import { Panel, type PanelProps } from '../src/components/Panel.js';
import { ChatTools } from '../src/components/ChatTools.js';

afterEach(cleanup);

const FILES: UiChangedFile[] = [
  { path: 'src/App.css', added: 13, removed: 14 },
  { path: 'src/App.jsx', added: 1, removed: 4 },
];

function checkpoints(n: number): UiCheckpoint[] {
  return Array.from({ length: n }, (_, i) => ({
    hash: `h${i}`,
    label: `edit_file: Edit src/App.css (replace ${i} lines)`,
    date: Date.UTC(2026, 7, 16, 2, i % 60),
  }));
}

function panelProps(over: Partial<PanelProps> = {}): PanelProps {
  return {
    tab: 'changes',
    onTab: vi.fn(),
    onClose: vi.fn(),
    changes: FILES,
    checkpoints: [],
    terminal: [],
    busy: false,
    loadDiff: () => Promise.resolve({ path: '', diff: '', added: 0, removed: 0 }),
    loadTree: () => Promise.resolve([]),
    loadFile: () => Promise.resolve({ path: '', content: '' }),
    onRevertFile: vi.fn(),
    onRevertAll: vi.fn(),
    onKeepAll: vi.fn(),
    onRewind: vi.fn(),
    artifacts: [],
    onSelectArtifact: vi.fn(),
    loadArtifact: () => Promise.resolve({ id: '', title: '', kind: 'html', content: '', version: 1, versions: 1 }),
    onSaveArtifact: vi.fn(),
    ...over,
  };
}

describe('the Changes tab', () => {
  it('summarises the session at the top, with the bulk actions beside it', () => {
    render(<Panel {...panelProps()} />);
    expect(screen.getByText('2 files')).toBeTruthy();
    expect(screen.getByText('+14')).toBeTruthy();
    expect(screen.getByText('−18')).toBeTruthy();
    expect(screen.getByText('Keep all')).toBeTruthy();
  });

  it('shows a short checkpoint list open, since hiding three items helps nobody', () => {
    render(<Panel {...panelProps({ checkpoints: checkpoints(3) })} />);
    expect(screen.getAllByText('Rewind')).toHaveLength(3);
  });

  it('starts a long one collapsed, with the count still visible', () => {
    // The reported problem: thirteen bordered cards, each with its own
    // full-size button, dwarfing the two changed files above them.
    render(<Panel {...panelProps({ checkpoints: checkpoints(13) })} />);
    expect(screen.queryByText('Rewind')).toBeNull();
    expect(screen.getByText('13')).toBeTruthy();

    fireEvent.click(screen.getByText('Checkpoints'));
    // Opened, but windowed — the rest is one more click away.
    expect(screen.getAllByText('Rewind')).toHaveLength(8);
    fireEvent.click(screen.getByText('Show all 13'));
    expect(screen.getAllByText('Rewind')).toHaveLength(13);
  });

  it('rewinds to the checkpoint that was clicked', () => {
    const onRewind = vi.fn();
    render(<Panel {...panelProps({ checkpoints: checkpoints(2), onRewind })} />);
    fireEvent.click(screen.getAllByText('Rewind')[1]!);
    expect(onRewind).toHaveBeenCalledWith('h1');
  });

  it('keeps Rewind in the tab order rather than hiding it until hover', () => {
    // It is dimmed, not display:none — hover-only controls are unreachable by
    // keyboard and on touch.
    const { container } = render(<Panel {...panelProps({ checkpoints: checkpoints(2) })} />);
    const rewind = container.querySelector('.cp-rewind');
    expect(rewind).not.toBeNull();
    expect((rewind as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables every destructive action mid-run', () => {
    render(<Panel {...panelProps({ checkpoints: checkpoints(2), busy: true })} />);
    for (const label of ['Keep all', 'Revert all']) {
      expect(screen.getByText<HTMLButtonElement>(label).disabled).toBe(true);
    }
    expect(screen.getAllByText<HTMLButtonElement>('Rewind')[0]!.disabled).toBe(true);
  });
});

describe('the workspace button', () => {
  it('badges the changed-file count without the panel being open', () => {
    render(<ChatTools panelOpen={false} changeCount={3} onTogglePanel={vi.fn()} />);
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('says nothing when there is nothing to say', () => {
    const { container } = render(<ChatTools panelOpen={false} changeCount={0} onTogglePanel={vi.fn()} />);
    expect(container.querySelector('.chat-tool-badge')).toBeNull();
  });

  it('toggles, and reports its state to assistive tech', () => {
    const onTogglePanel = vi.fn();
    const { rerender } = render(<ChatTools panelOpen={false} changeCount={0} onTogglePanel={onTogglePanel} />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onTogglePanel).toHaveBeenCalled();

    rerender(<ChatTools panelOpen changeCount={0} onTogglePanel={onTogglePanel} />);
    expect(screen.getByRole('button').getAttribute('aria-pressed')).toBe('true');
  });
});
