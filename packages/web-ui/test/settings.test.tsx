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
  const local = {
    name: 'local',
    preset: 'ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    active: false,
    hasKey: false,
    effectiveContextWindow: 8_000,
  };

  /**
   * The table is global now, so it is a sibling of the connection list rather
   * than a collapsed block inside each connection. `summary` is what the host
   * resolved, which is the thing worth reading: it says what actually serves
   * the role, including when the role inherited it.
   */
  const withRoles: UiSettings = {
    ...SETTINGS,
    profiles: [SETTINGS.profiles[0]!, local],
    roles: [
      { role: 'chat', connection: 'ollama', model: 'llama', summary: 'llama on ollama' },
      { role: 'agent', summary: 'inherits chat — llama on ollama' },
      { role: 'apply', connection: 'ollama', model: 'fast-apply', summary: 'fast-apply on ollama' },
      { role: 'edit', summary: 'inherits chat — llama on ollama' },
      { role: 'completion', summary: 'inherits chat — llama on ollama' },
      { role: 'embeddings', connection: 'local', model: 'nomic-embed', summary: 'nomic-embed on local' },
      { role: 'rerank', summary: 'inherits chat — llama on ollama' },
      { role: 'context', summary: 'inherits chat — llama on ollama' },
    ],
  };

  function openRoles(over: Partial<SettingsProps> = {}): void {
    render(<Settings {...props({ settings: withRoles, ...over })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
  }

  it('is visible without opening a connection, because it is not part of one', () => {
    // The old block lived inside every profile, so the same seven settings
    // appeared once per endpoint and switching endpoint changed all of them.
    openRoles();
    expect(screen.getByText('Model roles')).toBeTruthy();
    expect(screen.getByLabelText('Embeddings model')).toBeTruthy();
  });

  it('shows each role\'s assigned model and the connection it runs on', () => {
    openRoles();
    expect(screen.getByLabelText<HTMLInputElement>('Embeddings model').value).toBe('nomic-embed');
    expect(screen.getByLabelText<HTMLSelectElement>('Embeddings connection').value).toBe('local');
    expect(screen.getByLabelText<HTMLInputElement>('Apply model').value).toBe('fast-apply');
  });

  it('states what an inheriting role resolves to, rather than only what it would inherit from', () => {
    // The question the old screen made you trace a redirect and a fallback
    // chain to answer.
    openRoles();
    expect(screen.getByLabelText<HTMLInputElement>('Rerank model').placeholder).toBe(
      'inherits chat — llama on ollama',
    );
  });

  it('offers every connection for every role, including the one chat is on', () => {
    openRoles();
    const select = screen.getByLabelText<HTMLSelectElement>('Embeddings connection');
    expect([...select.options].map((o) => o.textContent)).toEqual(['on ollama', 'on local']);
  });

  it('assigns a role through its own message, not by saving a profile', () => {
    const onSetRole = vi.fn();
    openRoles({ onSetRole });
    fireEvent.change(screen.getByLabelText('Rerank model'), { target: { value: 'rerank-1' } });
    expect(onSetRole).toHaveBeenCalledWith('rerank', { connection: 'ollama', model: 'rerank-1' });
  });

  it('emptying a role clears it, so it inherits again', () => {
    const onSetRole = vi.fn();
    openRoles({ onSetRole });
    fireEvent.change(screen.getByLabelText('Embeddings model'), { target: { value: '' } });
    expect(onSetRole).toHaveBeenCalledWith('embeddings', undefined);
  });

  it('drops the model when the connection changes, rather than carrying it across', () => {
    // A model id means nothing on a host that does not serve it, and carrying
    // one across is how an assignment ends up naming something that fails at
    // request time instead of here.
    const onSetRole = vi.fn();
    openRoles({ onSetRole });
    fireEvent.change(screen.getByLabelText('Embeddings connection'), { target: { value: 'ollama' } });
    expect(onSetRole).toHaveBeenCalledWith('embeddings', { connection: 'ollama', model: '' });
  });

  it('suggests models from the connection the row points at, not the one being edited', async () => {
    const listConnectionModels = vi.fn(() => Promise.resolve(['nomic-embed-text']));
    openRoles({ listConnectionModels });
    fireEvent.focus(screen.getByLabelText('Embeddings model'));
    await waitFor(() => expect(listConnectionModels).toHaveBeenCalledWith('local'));
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

/**
 * Prompt detail.
 *
 * The tier was settable only by hand-editing config.json — which is where a
 * setting goes to be undiscovered. Three states, and the important one is the
 * default: "Automatic" is the absence of the field, not a third value, so the
 * capability-based choice keeps applying.
 */
describe('prompt detail', () => {
  function openProfile(over: Partial<SettingsProps> = {}): void {
    render(<Settings {...props({ ...over })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Providers' }));
    fireEvent.click(screen.getAllByText('Edit')[0]!);
  }

  it('defaults to Full when the profile sets nothing', () => {
    // Full is the default, and the empty value is how "nothing stored" is
    // spelled — there is no written-out 'full' in anyone's config.
    openProfile();
    expect(screen.getByLabelText<HTMLSelectElement>('Prompt detail').value).toBe('');
    expect(screen.getByText(/Full — every section \(default\)/)).toBeTruthy();
  });

  it('offers Automatic as a choice rather than as the default', () => {
    openProfile();
    const options = [...screen.getByLabelText<HTMLSelectElement>('Prompt detail').options].map((o) => o.value);
    expect(options).toEqual(['', 'lean', 'auto']);
  });

  it('sends the chosen tier', () => {
    const onSaveProfile = vi.fn();
    openProfile({ onSaveProfile });
    fireEvent.change(screen.getByLabelText('Prompt detail'), { target: { value: 'lean' } });
    fireEvent.click(screen.getByText('Save changes'));
    expect(onSaveProfile.mock.calls[0]![0]).toMatchObject({ promptTier: 'lean' });
  });

  it('sends null when set back to Full, which is how the host clears it', () => {
    // Nothing stored means full, so choosing Full is choosing to store
    // nothing — writing it out would put a value in every config that the
    // absence of a value already means.
    const onSaveProfile = vi.fn();
    const withTier: UiSettings = {
      ...SETTINGS,
      profiles: [{ ...SETTINGS.profiles[0]!, promptTier: 'lean' }],
    };
    openProfile({ settings: withTier, onSaveProfile });
    expect(screen.getByLabelText<HTMLSelectElement>('Prompt detail').value).toBe('lean');
    fireEvent.change(screen.getByLabelText('Prompt detail'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save changes'));
    expect(onSaveProfile.mock.calls[0]![0]).toMatchObject({ promptTier: null });
  });
});
