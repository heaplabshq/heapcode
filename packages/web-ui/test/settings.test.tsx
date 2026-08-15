// @vitest-environment jsdom
/**
 * The two-column settings dialog.
 *
 * It used to be every section stacked in one scroller. Splitting it means each
 * page can only be reached through the nav, so the risk moves: a page that is
 * unreachable, or a search that hides the page you are on, is now a way to lose
 * a setting entirely rather than just to scroll past it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiSettings } from '@heapcode/web-host/protocol';
import { Settings, type SettingsProps } from '../src/components/Settings.js';

afterEach(cleanup);

const SETTINGS: UiSettings = {
  persona: 'agent',
  personas: [{ id: 'agent', label: 'Agent', description: 'Full autonomy.' }],
  subAgents: false,
  nativeToolCalls: true,
  profiles: [
    {
      name: 'ollama',
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama',
      active: true,
      hasKey: false,
      effectiveContextWindow: 32_000,
    },
  ],
  webSearch: { provider: 'brave', providers: ['brave'], enabled: false, hasKey: false },
  mcpServers: [],
  permissionGrants: [],
};

function props(over: Partial<SettingsProps> = {}): SettingsProps {
  return {
    settings: SETTINGS,
    onClose: vi.fn(),
    onSetPersona: vi.fn(),
    onToggleSubAgents: vi.fn(),
    onToggleNativeTools: vi.fn(),
    onSetWebSearch: vi.fn(),
    onResetPermissions: vi.fn(),
    onUseProfile: vi.fn(),
    onDeleteProfile: vi.fn(),
    onSaveProfile: vi.fn(),
    ...over,
  };
}

describe('the settings dialog', () => {
  it('opens on General and shows one page at a time', () => {
    render(<Settings {...props()} />);
    expect(screen.getByText('Persona')).toBeTruthy();
    // Providers exists in the nav but its content is not rendered yet.
    expect(screen.getByRole('button', { name: 'Providers' })).toBeTruthy();
    expect(screen.queryByText('Add profile')).toBeNull();
  });

  it('reaches every page, including the ones that used to be slash commands', () => {
    render(<Settings {...props({ loadSkills: () => Promise.resolve('doc'), loadMemory: () => Promise.resolve('m') })} />);
    for (const page of ['Providers', 'Web search', 'Permissions', 'Skills', 'Connectors', 'Memory']) {
      fireEvent.click(screen.getByRole('button', { name: page }));
      // The page's own heading, which is rendered only when it is selected.
      expect(screen.getByRole('heading', { name: page })).toBeTruthy();
    }
  });

  it('lands on the profile editor when opened for context', () => {
    // `/context` and the context meter both want the window-size field, which
    // lives on the profile — not the front page.
    render(<Settings {...props({ focus: 'context' })} />);
    expect(screen.getByRole('heading', { name: 'Providers' })).toBeTruthy();
    expect(screen.getByText('Context window (tokens)')).toBeTruthy();
  });

  it('searches by what a page is for, not just its title', () => {
    render(<Settings {...props()} />);
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'api key' } });
    expect(screen.getByRole('button', { name: 'Providers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Web search' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Permissions' })).toBeNull();
  });

  it('keeps the current page rendered even when the search hides it from the nav', () => {
    // Filtering the nav must not blank the pane — the page you were reading is
    // still the page you are on.
    render(<Settings {...props()} />);
    fireEvent.change(screen.getByLabelText('Search settings'), { target: { value: 'mcp' } });
    expect(screen.queryByRole('button', { name: 'General' })).toBeNull();
    expect(screen.getByText('Persona')).toBeTruthy();
  });

  it('fetches skills only when that page is opened', async () => {
    const loadSkills = vi.fn(() => Promise.resolve('- deploy'));
    render(<Settings {...props({ loadSkills })} />);
    // Both of these read files off disk; paying for them on every open would
    // slow the common case for pages most visits never reach.
    expect(loadSkills).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Skills' }));
    await waitFor(() => expect(loadSkills).toHaveBeenCalled());
    expect(await screen.findByText('- deploy')).toBeTruthy();
  });
});

describe('model roles', () => {
  const withRoles: UiSettings = {
    ...SETTINGS,
    profiles: [
      { ...SETTINGS.profiles[0]!, embeddingsModel: 'nomic-embed', applyModel: 'fast-apply' },
      {
        name: 'local',
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama',
        active: false,
        hasKey: false,
        effectiveContextWindow: 8_000,
      },
    ],
  };

  function openRoles(over: Partial<SettingsProps> = {}): void {
    render(<Settings {...props({ settings: withRoles, ...over })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
    fireEvent.click(screen.getAllByText('Edit')[0]!);
    fireEvent.click(screen.getByText(/Model roles/));
  }

  it('is collapsed by default, and says how many roles are set', () => {
    render(<Settings {...props({ settings: withRoles })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
    fireEvent.click(screen.getAllByText('Edit')[0]!);
    // Most profiles need none of this, so it stays out of the way — but the
    // count says whether there is anything behind the toggle.
    expect(screen.queryByLabelText('Embeddings model')).toBeNull();
    expect(screen.getByText('2 set')).toBeTruthy();
  });

  it('loads the stored role models into their fields', () => {
    openRoles();
    expect(screen.getByLabelText<HTMLInputElement>('Embeddings model').value).toBe('nomic-embed');
    expect(screen.getByLabelText<HTMLInputElement>('Apply model').value).toBe('fast-apply');
    expect(screen.getByLabelText<HTMLInputElement>('Rerank model').value).toBe('');
  });

  it('offers the other profiles for running a role elsewhere, but not itself', () => {
    openRoles();
    const select = screen.getByLabelText<HTMLSelectElement>('Embeddings profile');
    const options = [...select.options].map((o) => o.textContent);
    // Pointing a role at its own profile is what leaving it unset already means.
    expect(options).toEqual(['this profile', 'on local']);
  });

  it('sends roles flattened, the way a stored profile carries them', () => {
    const onSaveProfile = vi.fn();
    openRoles({ onSaveProfile });
    fireEvent.change(screen.getByLabelText('Rerank model'), { target: { value: 'rerank-1' } });
    fireEvent.change(screen.getByLabelText('Embeddings profile'), { target: { value: 'local' } });
    fireEvent.click(screen.getByText('Save changes'));

    const sent = onSaveProfile.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      name: 'ollama',
      rerankModel: 'rerank-1',
      embeddingsProfile: 'local',
      embeddingsModel: 'nomic-embed',
    });
    // The form's nested map is an editor detail; it never crosses the wire.
    expect(sent.roles).toBeUndefined();
  });

  it('sends an emptied field as "", which the host reads as "clear it"', () => {
    const onSaveProfile = vi.fn();
    openRoles({ onSaveProfile });
    fireEvent.change(screen.getByLabelText('Embeddings model'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save changes'));
    expect(onSaveProfile.mock.calls[0]![0]).toMatchObject({ embeddingsModel: '' });
  });
});
