// @vitest-environment jsdom
/**
 * The left rail and the workspace picker.
 *
 * Both replaced things that used to be elsewhere — the rail replaced a top
 * header bar, and the picker is new — so what matters here is that nothing the
 * header carried got dropped on the way, and that switching folder cannot
 * happen behind the user's back while the agent is mid-run.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiState } from '@heapcode/web-host/protocol';
import { Sidebar, type SidebarProps } from '../src/components/Sidebar.js';
import { WorkspacePicker } from '../src/components/WorkspacePicker.js';

afterEach(cleanup);

const STATE = {
  root: '/Users/me/code/app',
  workspaceName: 'app',
  profile: 'ollama',
  model: 'llama',
  persona: 'agent',
  permissionMode: 'default',
  contextWindow: 32_000,
  profiles: [],
  daemon: 'up',
} satisfies UiState;

function railProps(over: Partial<SidebarProps> = {}): SidebarProps {
  return {
    collapsed: false,
    onToggleCollapsed: vi.fn(),
    conversations: [
      { id: 'a', title: 'Fix the diff colours', updatedAt: 1, active: true },
      { id: 'b', title: 'Add ads to site', updatedAt: 2, active: false },
    ],
    onOpen: vi.fn(),
    onNew: vi.fn(),
    busy: false,
    state: STATE,
    status: 'open',
    onOpenArtifacts: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenPalette: vi.fn(),
    ...over,
  };
}

describe('the left rail', () => {
  it('carries the brand, connection and profile', () => {
    const { container } = render(<Sidebar {...railProps()} />);
    expect(screen.getByText('Heap Code')).toBeTruthy();
    expect(container.querySelector('.dot-open')).not.toBeNull();
    expect(screen.getByText('ollama')).toBeTruthy();
  });

  it('holds nothing that is really a workspace-panel tab', () => {
    // Changes, Files and Terminal are tabs of the panel, not destinations of
    // their own — a rail entry named after one could only open that single tab
    // while looking like it owned the whole panel. ChatTools opens the panel;
    // the tabs take it from there.
    render(<Sidebar {...railProps()} />);
    fireEvent.click(screen.getByText('More'));
    for (const gone of ['Changes', 'Files', 'Terminal']) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it('marks the open conversation, and only that one', () => {
    const { container } = render(<Sidebar {...railProps()} />);
    const on = container.querySelectorAll('.convo-dot-on');
    expect(on).toHaveLength(1);
    expect(container.querySelector('.convo-active')?.textContent).toContain('Fix the diff colours');
  });

  it('will not start a new chat or switch conversations mid-run', () => {
    const onNew = vi.fn();
    const onOpen = vi.fn();
    render(<Sidebar {...railProps({ busy: true, onNew, onOpen })} />);
    fireEvent.click(screen.getByText('New'));
    fireEvent.click(screen.getByText('Add ads to site'));
    expect(onNew).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('collapses to icons, keeping each one reachable by name', () => {
    const { container } = render(<Sidebar {...railProps({ collapsed: true })} />);
    expect(screen.queryByText('Heap Code')).toBeNull();
    expect(container.querySelector('.rail-recents')).toBeNull();
    // Labels are gone from sight, not from the accessibility tree.
    expect(screen.getByLabelText('Artifacts')).toBeTruthy();
  });

  it('hides the More group until it is asked for', () => {
    render(<Sidebar {...railProps()} />);
    expect(screen.queryByText('Commands')).toBeNull();
    fireEvent.click(screen.getByText('More'));
    expect(screen.getByText('Commands')).toBeTruthy();
  });
});

describe('the workspace picker', () => {
  const recent = {
    current: '/Users/me/code/app',
    home: '/Users/me',
    recent: [
      { path: '/Users/me/code/app', name: 'app', lastOpened: 2 },
      { path: '/Users/me/code/other', name: 'other', lastOpened: 1 },
    ],
  };

  it('names the current folder and offers the recent ones', async () => {
    render(
      <WorkspacePicker
        current="/Users/me/code/app"
        busy={false}
        loadWorkspaces={() => Promise.resolve(recent)}
        browse={() => Promise.reject(new Error('not used'))}
        onPick={() => Promise.resolve()}
      />,
    );
    expect(screen.getByText('app')).toBeTruthy();
    fireEvent.click(screen.getByText('app'));
    await waitFor(() => expect(screen.getByText('other')).toBeTruthy());
    // Paths are shortened against home so a row fits.
    expect(screen.getAllByText('~/code').length).toBeGreaterThan(0);
  });

  it('is inert while a run is in flight', () => {
    const onPick = vi.fn(() => Promise.resolve());
    render(
      <WorkspacePicker
        current="/Users/me/code/app"
        busy
        loadWorkspaces={() => Promise.resolve(recent)}
        browse={() => Promise.reject(new Error('not used'))}
        onPick={onPick}
      />,
    );
    fireEvent.click(screen.getByText('app'));
    // No popup, no switch: moving the root under a running agent would turn
    // its next edit into an edit of the wrong repo.
    expect(screen.queryByText('Recent')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('keeps the popup open and shows why when a folder will not open', async () => {
    render(
      <WorkspacePicker
        current="/Users/me/code/app"
        busy={false}
        loadWorkspaces={() => Promise.resolve(recent)}
        browse={() => Promise.reject(new Error('not used'))}
        onPick={() => Promise.reject(new Error('Not a folder: /Users/me/code/other'))}
      />,
    );
    fireEvent.click(screen.getByText('app'));
    await waitFor(() => screen.getByText('other'));
    fireEvent.click(screen.getByText('other'));
    // Closing optimistically would leave the chip naming a folder the host
    // never moved to.
    await waitFor(() => expect(screen.getByText(/Not a folder/)).toBeTruthy());
    expect(screen.getByText('Recent')).toBeTruthy();
  });

  it('browses from beside the current folder, not from home', async () => {
    const browse = vi.fn(() =>
      Promise.resolve({
        path: '/Users/me/code',
        parent: '/Users/me',
        entries: [{ name: 'other', path: '/Users/me/code/other' }],
      }),
    );
    render(
      <WorkspacePicker
        current="/Users/me/code/app"
        busy={false}
        loadWorkspaces={() => Promise.resolve(recent)}
        browse={browse}
        onPick={() => Promise.resolve()}
      />,
    );
    fireEvent.click(screen.getByText('app'));
    fireEvent.click(await screen.findByText('Browse'));
    // The sibling of the current project is overwhelmingly where the next one
    // is; starting at home would mean clicking down through it every time.
    await waitFor(() => expect(browse).toHaveBeenCalledWith('/Users/me/code'));
  });
});
