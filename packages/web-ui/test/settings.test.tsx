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
  presets: [
    { id: 'ollama', label: 'Ollama', defaultBaseUrl: 'http://localhost:11434/v1', requiresApiKey: false, local: true },
    {
      id: 'ollama-cloud',
      label: 'Ollama Cloud',
      defaultBaseUrl: 'https://ollama.com/v1',
      requiresApiKey: true,
      local: false,
      apiKeyUrl: 'https://ollama.com/settings/keys',
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
    onSaveMcpServer: vi.fn(),
    onDeleteMcpServer: vi.fn(),
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

  describe('the provider list', () => {
    /** Opens Providers → Add profile and returns the preset dropdown + URL field. */
    function openAddProfile() {
      render(<Settings {...props()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
      return {
        preset: screen.getAllByRole('combobox').find((el) => el.querySelector('option[value="ollama-cloud"]'))!,
        baseUrl: screen.getByPlaceholderText('http://localhost:11434/v1') as HTMLInputElement,
      };
    }

    it('lists what the host actually supports, under its real label', () => {
      // The browser bundle used to restate this list itself and went stale:
      // a preset added in core never showed up here.
      const { preset } = openAddProfile();
      expect(screen.getByRole('option', { name: 'Ollama Cloud' })).toBeTruthy();
      expect(preset.querySelectorAll('option')).toHaveLength(2);
    });

    it('fills in the endpoint when a provider is picked, instead of leaving it blank', () => {
      const { preset, baseUrl } = openAddProfile();
      expect(baseUrl.value).toBe('http://localhost:11434/v1'); // the default preset's own URL
      fireEvent.change(preset, { target: { value: 'ollama-cloud' } });
      expect(baseUrl.value).toBe('https://ollama.com/v1');
    });

    it('does not clobber a base URL the user typed', () => {
      const { preset } = openAddProfile();
      const url = screen.getByPlaceholderText('http://localhost:11434/v1');
      fireEvent.change(url, { target: { value: 'http://my-box.lan:11434/v1' } });
      fireEvent.change(preset, { target: { value: 'ollama-cloud' } });
      expect(screen.getByDisplayValue('http://my-box.lan:11434/v1')).toBeTruthy();
    });

    it('tests the connection and turns the answer into a model dropdown', async () => {
      const probeProvider = vi.fn().mockResolvedValue({ ok: true, models: ['gpt-oss:120b', 'kimi-k3'] });
      render(<Settings {...props({ probeProvider })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));

      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() => expect(screen.getByText('connected')).toBeTruthy());
      expect(probeProvider).toHaveBeenCalledWith({
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: undefined,
      });
      expect(screen.getByText('2 models available.')).toBeTruthy();

      // The models it found are now selectable, not something to remember.
      fireEvent.focus(screen.getByLabelText('Model'));
      // mousedown, not click — the list is torn down by blur before a click lands.
      fireEvent.mouseDown(screen.getByRole('option', { name: 'kimi-k3' }));
      expect((screen.getByLabelText('Model') as HTMLInputElement).value).toBe('kimi-k3');
    });

    it('surfaces why a connection failed instead of just not listing models', async () => {
      const probeProvider = vi.fn().mockResolvedValue({ ok: false, models: [], error: 'HTTP 401 Unauthorized' });
      render(<Settings {...props({ probeProvider })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() => expect(screen.getByText('failed')).toBeTruthy());
      expect(screen.getByText('HTTP 401 Unauthorized')).toBeTruthy();
    });

    it('drops a stale result when the endpoint is edited', async () => {
      const probeProvider = vi.fn().mockResolvedValue({ ok: true, models: ['a'] });
      render(<Settings {...props({ probeProvider })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() => expect(screen.getByText('connected')).toBeTruthy());
      // A "connected" badge next to a URL that was never tested is a lie.
      fireEvent.change(screen.getByPlaceholderText('http://localhost:11434/v1'), {
        target: { value: 'http://elsewhere:1234/v1' },
      });
      expect(screen.queryByText('connected')).toBeNull();
    });

    it('sends the typed key when testing, so a new provider can be verified before saving', async () => {
      const probeProvider = vi.fn().mockResolvedValue({ ok: true, models: [] });
      render(<Settings {...props({ probeProvider })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
      fireEvent.click(screen.getByRole('button', { name: 'Add profile' }));
      const preset = screen.getAllByRole('combobox').find((el) => el.querySelector('option[value="ollama-cloud"]'))!;
      fireEvent.change(preset, { target: { value: 'ollama-cloud' } });
      fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-test' } });
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      await waitFor(() =>
        expect(probeProvider).toHaveBeenCalledWith({
          preset: 'ollama-cloud',
          baseUrl: 'https://ollama.com/v1',
          apiKey: 'sk-test',
        }),
      );
    });

    it('says where to get a key for the providers that need one', () => {
      const { preset } = openAddProfile();
      fireEvent.change(preset, { target: { value: 'ollama-cloud' } });
      const link = screen.getByRole('link', { name: 'https://ollama.com/settings/keys' });
      expect(link.getAttribute('href')).toBe('https://ollama.com/settings/keys');
    });
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

describe('role model suggestions', () => {
  const withRoles: UiSettings = {
    ...SETTINGS,
    profiles: [
      SETTINGS.profiles[0]!,
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

  function openRoles(listModels: (p: string) => Promise<string[]>): void {
    render(<Settings {...props({ settings: withRoles, listModels })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
    fireEvent.click(screen.getAllByText('Edit')[0]!);
    fireEvent.click(screen.getByText(/Model roles/));
  }

  it('suggests from this profile when the role is not redirected', async () => {
    const listModels = vi.fn(() => Promise.resolve(['nomic-embed-text']));
    openRoles(listModels);
    fireEvent.focus(screen.getByLabelText('Embeddings model'));
    await waitFor(() => expect(listModels).toHaveBeenCalledWith('ollama'));
  });

  it('offers nothing to type once the role is redirected', async () => {
    // There is no box to suggest into: a redirected role takes its model from
    // the profile it was redirected to, so this row stops asking for one.
    const listModels = vi.fn(() => Promise.resolve([]));
    openRoles(listModels);
    fireEvent.change(screen.getByLabelText('Embeddings profile'), { target: { value: 'local' } });
    expect(screen.queryByRole('textbox', { name: 'Embeddings model' })).toBeNull();
    await waitFor(() => expect(listModels).not.toHaveBeenCalledWith('local'));
  });
});

/**
 * What a redirected role actually runs.
 *
 * The row used to show a model box beside the profile dropdown, as though the
 * two were independent settings. They are not: `providerForRole` resolves the
 * target profile and the model is then read off *that* one, so a model typed
 * here was stored, displayed, and never used. Which is how a working config
 * can sit on disk with semantic search reporting no embedder.
 */
describe('a role redirected to another profile', () => {
  const withTarget: UiSettings = {
    ...SETTINGS,
    profiles: [
      { ...SETTINGS.profiles[0]!, embeddingsProfile: 'local' },
      {
        name: 'local',
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama',
        embeddingsModel: 'nomic-embed-text',
        active: false,
        hasKey: false,
        effectiveContextWindow: 8_000,
      },
    ],
  };

  function open(settings: UiSettings): void {
    render(<Settings {...props({ settings })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
    fireEvent.click(screen.getAllByText('Edit')[0]!);
    fireEvent.click(screen.getByText(/Model roles/));
  }

  it('names the model the target will run, not an empty box', () => {
    open(withTarget);
    expect(screen.getByText('nomic-embed-text')).toBeTruthy();
    expect(screen.getByText(/from local/)).toBeTruthy();
  });

  it('says where to set one when the target has none', () => {
    // The failure this replaces was silent: the role was redirected, the
    // target had no embeddings model, and the panel showed a blank field that
    // looked settable.
    open({
      ...withTarget,
      profiles: [withTarget.profiles[0]!, { ...withTarget.profiles[1]!, embeddingsModel: undefined }],
    });
    expect(screen.getByText(/no embeddings model on local; set one there/)).toBeTruthy();
  });

  it('leaves the roles that are not redirected editable', () => {
    open(withTarget);
    expect(screen.getByLabelText<HTMLInputElement>('Rerank model')).toBeTruthy();
  });
});

/**
 * Connectors.
 *
 * The page used to be a list ending in "add them to ~/.heapcode/config.json
 * yourself", which is the one thing a settings screen exists to save you
 * from. The CLI said the same; only the extension could add one, and it wrote
 * to VS Code's own settings, so what it added never appeared here.
 */
describe('MCP servers', () => {
  const withServers: UiSettings = {
    ...SETTINGS,
    mcpServers: [
      { name: 'filesystem', connected: true, tools: ['mcp__filesystem__read'], spec: 'npx -y server-fs /code' },
      { name: 'teamserver', connected: false, tools: [], spec: 'npx -y team', project: true },
    ],
  };

  function open(over: Partial<SettingsProps> = {}): void {
    render(<Settings {...props({ settings: withServers, ...over })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connectors' }));
  }

  it('adds a server from one field, without asking for a transport first', () => {
    // A server is either a URL or a command line, and the string already says
    // which — the host parses it the same way the CLI does.
    const onSaveMcpServer = vi.fn();
    open({ onSaveMcpServer });
    fireEvent.change(screen.getByLabelText('MCP server name'), { target: { value: 'github' } });
    fireEvent.change(screen.getByLabelText('MCP server command or URL'), {
      target: { value: 'https://mcp.example.com/sse' },
    });
    fireEvent.click(screen.getByText('Add server'));
    expect(onSaveMcpServer).toHaveBeenCalledWith('github', 'https://mcp.example.com/sse');
  });

  it('will not send a half-filled form', () => {
    const onSaveMcpServer = vi.fn();
    open({ onSaveMcpServer });
    fireEvent.change(screen.getByLabelText('MCP server name'), { target: { value: 'github' } });
    fireEvent.click(screen.getByText('Add server'));
    expect(onSaveMcpServer).not.toHaveBeenCalled();
  });

  it('shows what each server is configured as, not just its name', () => {
    open();
    expect(screen.getByText('npx -y server-fs /code')).toBeTruthy();
  });

  it('removes one', () => {
    const onDeleteMcpServer = vi.fn();
    open({ onDeleteMcpServer });
    fireEvent.click(screen.getAllByText('Remove')[0]!);
    expect(onDeleteMcpServer).toHaveBeenCalledWith('filesystem');
  });

  it("shows a project's own server but offers no way to edit it", () => {
    // `.heapcode/mcp.json` is meant to be committed. A settings panel writing
    // to a file under version control on someone's behalf is the one thing it
    // must not do — so that row is displayed and left alone.
    open();
    expect(screen.getByText('teamserver')).toBeTruthy();
    expect(screen.getByText(/from this project/)).toBeTruthy();
    // One Remove button, for the personal server — not two.
    expect(screen.getAllByText('Remove')).toHaveLength(1);
  });
});
