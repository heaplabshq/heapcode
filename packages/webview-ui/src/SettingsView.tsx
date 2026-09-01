import { useEffect, useRef, useState } from 'react';
import type {
  ExtensionToWebview,
  ModelAssignment,
  ModelRole,
  ModelRoleTable,
  ProviderProfileConfig,
  SettingsPresetInfo,
} from '@heapcode/core';
import { MODEL_ROLES } from '@heapcode/core';
import { filterModels } from '@heapcode/core/modelFilter';
import { postToExtension } from './vscodeApi.js';

export interface SettingsData {
  profiles: ProviderProfileConfig[];
  active: string;
  presets: SettingsPresetInfo[];
  keySaved: Record<string, boolean>;
  /** Which model on which connection serves each role — one global table. */
  roles: ModelRoleTable;
  /** Each role already resolved to a sentence, so this screen states outcomes rather than fields. */
  roleSummary: Record<ModelRole, string>;
  subAgentsEnabled: boolean;
}

/** What each role is for, in the order the panel lists them. */
const ROLE_META: Record<ModelRole, { icon: string; label: string; hint: string }> = {
  chat: { icon: '💬', label: 'Chat', hint: 'Conversations in the sidebar. Every other role inherits from this one.' },
  agent: { icon: '🤖', label: 'Agent', hint: 'Agent mode — a strong tool-calling model.' },
  edit: { icon: '✏️', label: 'Edit', hint: 'Inline edit (Ctrl+I) and commit messages.' },
  apply: {
    icon: '🔀',
    label: 'Apply',
    hint: 'Fast-apply merge model, used when an edit’s search text does not match. Inherits nothing — unset means edits fall back to selection/insert.',
  },
  completion: { icon: '⚡', label: 'Autocomplete', hint: 'Editor ghost text — pick a FIM-capable coder model.' },
  embeddings: {
    icon: '🔍',
    label: 'Embeddings',
    hint: 'Semantic search and the repo index. Inherits nothing on purpose: a chat model asked to embed returns something that is not an embedding, and that shows up as bad results rather than as an error.',
  },
  rerank: { icon: '🔢', label: 'Rerank', hint: 'Reranks search hits. A small fast model works well.' },
  context: { icon: '📝', label: 'Context', hint: 'A short blurb per chunk at index time. A small fast model works well.' },
};

/** Working copy of a profile being edited; strings throughout for form binding. */
interface Draft {
  /** Name before editing began; undefined = new profile. */
  original?: string;
  name: string;
  preset: string;
  baseUrl: string;
  /**
   * The chat model on this connection.
   *
   * Only chat. The other roles are not properties of an endpoint any more —
   * they live in one global table on the main screen, so this form no longer
   * carries seven model fields and seven "run this on another profile"
   * dropdowns.
   */
  model: string;
  contextWindow: string;
  temperature: string;
  maxTokens: string;
  /** Seconds, for form binding — converted to/from timeoutMs (ms). */
  timeoutSec: string;
  /**
   * Per-profile capability overrides. Only nativeToolCalls is editable here —
   * it is the one a user has to reach for, because a model whose chat template
   * lacks tool support rejects every request carrying tools.
   */
  capabilities?: ProviderProfileConfig['capabilities'];
  /** '' = untouched; anything typed is stored on save. */
  apiKey: string;
  clearKey: boolean;
}

function toDraft(p: ProviderProfileConfig): Draft {
  return {
    original: p.name,
    name: p.name,
    preset: p.preset,
    baseUrl: p.baseUrl,
    model: p.model ?? '',
    contextWindow: p.contextWindow != null ? String(p.contextWindow) : '',
    temperature: p.temperature != null ? String(p.temperature) : '',
    maxTokens: p.maxTokens != null ? String(p.maxTokens) : '',
    timeoutSec: p.timeoutMs != null ? String(Math.round(p.timeoutMs / 1000)) : '',
    capabilities: p.capabilities,
    apiKey: '',
    clearKey: false,
  };
}

function newDraft(preset: SettingsPresetInfo): Draft {
  return {
    name: preset.id,
    preset: preset.id,
    baseUrl: preset.defaultBaseUrl,
    model: '',
    contextWindow: '',
    temperature: '',
    maxTokens: '',
    timeoutSec: '',
    apiKey: '',
    clearKey: false,
  };
}

function fromDraft(d: Draft): ProviderProfileConfig {
  const num = (s: string): number | undefined => {
    const n = Number(s);
    return s.trim() !== '' && Number.isFinite(n) ? n : undefined;
  };
  const opt = (s: string): string | undefined => (s.trim() !== '' ? s.trim() : undefined);
  const profile: ProviderProfileConfig = {
    name: d.name.trim(),
    preset: d.preset as ProviderProfileConfig['preset'],
    baseUrl: d.baseUrl.trim(),
    model: d.model.trim(),
  };
  if (num(d.contextWindow) != null) profile.contextWindow = num(d.contextWindow);
  if (num(d.temperature) != null) profile.temperature = num(d.temperature);
  if (num(d.maxTokens) != null) profile.maxTokens = num(d.maxTokens);
  if (num(d.timeoutSec) != null) profile.timeoutMs = num(d.timeoutSec)! * 1000;
  // Only carried when something was actually overridden — an empty object here
  // would shadow nothing but would churn settings.json on every save.
  if (d.capabilities && Object.keys(d.capabilities).length > 0) profile.capabilities = d.capabilities;
  return profile;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      <input
        className="settings-input"
        type={type ?? 'text'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * A model input that becomes a searchable dropdown once a connection test has
 * listed models (a plain <select> is unusable past a few hundred entries —
 * OpenRouter alone lists 342) — with an always-available "type manually"
 * escape hatch, since some endpoints (Azure deployments, unlisted local
 * models) never populate a list at all.
 */
function ModelPickerInput({
  value,
  onChange,
  models,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  models: string[];
  placeholder?: string;
}) {
  const [manual, setManual] = useState(false);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      setFilter('');
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const showPicker = models.length > 0 && !manual;
  if (!showPicker) {
    return (
      <div className="settings-key-row">
        <input
          className="settings-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {models.length > 0 && (
          <button className="ghost" title="Pick from the tested model list" onClick={() => setManual(false)}>
            ▾
          </button>
        )}
      </div>
    );
  }

  const filtered = filterModels(models, filter);

  return (
    <div className="settings-model-picker" ref={ref}>
      <div className="settings-key-row">
        <button
          type="button"
          className="settings-input settings-model-chip"
          onClick={() => setOpen((v) => !v)}
        >
          {value || '— none / not set —'}
        </button>
        <button
          className="ghost"
          title="Type a model id manually instead"
          onClick={() => {
            setManual(true);
            setOpen(false);
          }}
        >
          ✎
        </button>
      </div>
      {open && (
        <div className="model-menu settings-model-menu">
          {models.length > 8 && (
            <input
              autoFocus
              className="model-search"
              type="text"
              placeholder={`Filter ${models.length} models…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          <div className="settings-model-menu-list">
            <button
              className={`menu-item${value === '' ? ' active' : ''}`}
              onClick={() => {
                onChange('');
                setOpen(false);
                setFilter('');
              }}
            >
              {value === '' ? '✓ ' : ''}— none / not set —
            </button>
            {filtered.length === 0 && <div className="menu-note">No models match "{filter}"</div>}
            {filtered.map((m) => (
              <button
                key={m}
                className={`menu-item${m === value ? ' active' : ''}`}
                onClick={() => {
                  onChange(m);
                  setOpen(false);
                  setFilter('');
                }}
              >
                {m === value ? '✓ ' : ''}
                {m}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One role: which connection, which model, and what it resolves to.
 *
 * The old screen gave each role a model box plus a "run on profile" dropdown,
 * on every profile, and left the reader to trace the redirect and then the
 * fallback chain. This states the outcome in a sentence and lets the model be
 * picked from any connection, because a role names a model — it is not a
 * property of an endpoint.
 */
function RoleRow({
  role,
  assignment,
  summary,
  connections,
  models,
  onRequestModels,
  onChange,
}: {
  role: ModelRole;
  assignment?: ModelAssignment;
  summary: string;
  connections: string[];
  models: Record<string, string[]>;
  onRequestModels: (connection: string) => void;
  onChange: (assignment?: ModelAssignment) => void;
}) {
  const meta = ROLE_META[role];
  const connection = assignment?.connection ?? connections[0] ?? '';
  return (
    <div className="settings-role-row">
      <div className="settings-role-head">
        <span className="settings-role-icon" aria-hidden="true">
          {meta.icon}
        </span>
        <span className="settings-role-label">{meta.label}</span>
        <span className="settings-role-summary">{summary}</span>
        {/* Clearing has to be reachable from the same place the choice was
            made. Chat is what the chain bottoms out at, so it cannot inherit. */}
        {role !== 'chat' && assignment && (
          <button className="ghost settings-role-clear" title="Inherit instead" onClick={() => onChange(undefined)}>
            Inherit
          </button>
        )}
      </div>
      <div className="settings-role-controls">
        <select
          className="settings-input"
          value={connection}
          onChange={(e) => {
            onRequestModels(e.target.value);
            // Changing the endpoint clears the model: a model id means nothing
            // on a host that does not serve it, and carrying it across is how
            // an assignment ends up naming something that fails at request
            // time rather than here.
            onChange({ ...assignment, connection: e.target.value, model: '' });
          }}
        >
          {connections.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <ModelPickerInput
          value={assignment?.model ?? ''}
          onChange={(model) => onChange(model ? { ...assignment, connection, model } : undefined)}
          models={models[connection] ?? []}
          placeholder={meta.hint}
        />
      </div>
    </div>
  );
}

interface TestState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  models: string[];
  error?: string;
}

export function SettingsView({ data }: { data: SettingsData | null }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showRoles, setShowRoles] = useState(false);
  const [test, setTest] = useState<TestState>({ status: 'idle', models: [] });
  /**
   * Model ids per connection, for the role rows.
   *
   * Fetched per connection and on demand rather than all at once, so an
   * endpoint that is not running costs only the row pointing at it. A local
   * Ollama that is switched off is the ordinary case for someone whose other
   * connection is a cloud provider.
   */
  const [connectionModels, setConnectionModels] = useState<Record<string, string[]>>({});
  const requested = useRef(new Set<string>());
  const requestModels = (connection: string): void => {
    if (!connection || requested.current.has(connection)) return;
    requested.current.add(connection);
    postToExtension({ type: 'settingsListConnectionModels', connection });
  };

  useEffect(() => {
    const onMessage = (e: MessageEvent<ExtensionToWebview>) => {
      const msg = e.data;
      if (msg.type === 'settingsConnectionModels') {
        setConnectionModels((m) => ({ ...m, [msg.connection]: msg.models }));
        return;
      }
      if (msg.type !== 'settingsModels') return;
      setTest(
        msg.error
          ? { status: 'error', models: [], error: msg.error }
          : { status: 'ok', models: msg.models },
      );
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!data) return <div className="empty">Loading settings…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  /** Connection-affecting fields invalidate any previously tested model list. */
  const setConnection = (patch: Partial<Draft>) => {
    setTest({ status: 'idle', models: [] });
    set(patch);
  };
  /** Opening/closing a draft always starts with a clean (not stale) test state. */
  const openDraft = (d: Draft | null) => {
    setTest({ status: 'idle', models: [] });
    setDraft(d);
  };

  if (draft) {
    const preset = data.presets.find((p) => p.id === draft.preset);
    const keySaved = draft.original ? (data.keySaved[draft.original] ?? false) : false;
    const inherits = `inherits chat (${draft.model || 'not set'})`;
    const otherProfiles = data.profiles.map((p) => p.name).filter((n) => n !== draft.name);
    const canTest = draft.baseUrl.trim() !== '' && (draft.apiKey.trim() !== '' || keySaved || !preset?.requiresApiKey);
    const testConnection = () => {
      setTest({ status: 'loading', models: [] });
      postToExtension({
        type: 'settingsTestConnection',
        profile: fromDraft(draft),
        apiKey: draft.clearKey ? undefined : draft.apiKey.trim() !== '' ? draft.apiKey : undefined,
        originalName: draft.original,
      });
    };
    return (
      <div className="settings">
        <div className="settings-header">
          <button className="ghost settings-back" title="Back to profiles" onClick={() => openDraft(null)}>
            ←
          </button>
          <div>
            <div className="settings-title">{draft.original ? 'Edit profile' : 'New profile'}</div>
            {draft.original && <div className="settings-subtitle">{draft.original}</div>}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Connection</div>
          <Field label="Name" value={draft.name} onChange={(name) => set({ name })} />
          <label className="settings-field">
            <span className="settings-label">Provider</span>
            <select
              className="settings-input"
              value={draft.preset}
              onChange={(e) => {
                const next = data.presets.find((p) => p.id === e.target.value);
                if (!next) return;
                // Follow the preset's default URL unless the user customized it.
                const wasDefault = !draft.baseUrl || draft.baseUrl === preset?.defaultBaseUrl;
                setConnection({ preset: next.id, baseUrl: wasDefault ? next.defaultBaseUrl : draft.baseUrl });
              }}
            >
              {data.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.local ? ' (local)' : ''}
                </option>
              ))}
            </select>
          </label>
          <Field label="Base URL" value={draft.baseUrl} onChange={(baseUrl) => setConnection({ baseUrl })} />

          <label className="settings-field">
            <span className="settings-label">
              API key{' '}
              {keySaved && !draft.clearKey && <span className="settings-key-badge">saved</span>}
            </span>
            <div className="settings-key-row">
              <input
                className="settings-input"
                type="password"
                value={draft.apiKey}
                placeholder={
                  draft.clearKey
                    ? 'will be cleared on save'
                    : keySaved
                      ? '•••••••• (unchanged)'
                      : preset?.requiresApiKey
                        ? 'required by this provider'
                        : 'optional'
                }
                onChange={(e) => setConnection({ apiKey: e.target.value, clearKey: false })}
              />
              {keySaved && !draft.clearKey && (
                <button className="ghost danger" onClick={() => setConnection({ apiKey: '', clearKey: true })}>
                  Clear
                </button>
              )}
            </div>
          </label>

          <div className="settings-test-row">
            <button className="ghost" disabled={!canTest || test.status === 'loading'} onClick={testConnection}>
              {test.status === 'loading' ? 'Testing…' : 'Test connection'}
            </button>
            {test.status === 'ok' && (
              <span className="settings-test-ok">
                ✓ Connected — {test.models.length} model{test.models.length === 1 ? '' : 's'} found
              </span>
            )}
            {test.status === 'error' && <span className="settings-test-error">✗ {test.error}</span>}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Chat model</div>
          <label className="settings-field">
            <span className="settings-label">Model</span>
            <ModelPickerInput
              value={draft.model}
              onChange={(model) => set({ model })}
              models={test.models}
              placeholder="e.g. llama3.1, gpt-4o"
            />
          </label>
          {test.status === 'idle' && (
            <p className="settings-note">Test the connection above to pick a model from a list.</p>
          )}
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Tool calling</div>
          <label className="settings-toggle-row">
            <input
              type="checkbox"
              checked={draft.capabilities?.nativeToolCalls !== false}
              onChange={(e) =>
                set({ capabilities: { ...draft.capabilities, nativeToolCalls: e.target.checked } })
              }
            />
            <span>
              <strong>Native tool calling</strong>
              <div className="settings-subtitle">
                Send tool definitions through the API's <code>tools</code> field. Turn this off for
                models whose chat template has no tool support — many local GGUF builds (Gemma 2 and
                Codestral among them) reject any request carrying tools, which shows up as a 400 the
                moment the agent moves past planning. With it off, tools are described in the prompt
                instead, which works on any model that can follow instructions.
              </div>
            </span>
          </label>
        </div>

        <div className="settings-section">
          <button className="settings-roles-toggle" onClick={() => setShowRoles((v) => !v)}>
            <span className="tools-group-chevron">{showRoles ? '▾' : '▸'}</span>
            <span className="settings-section-title">Tuning</span>
          </button>
          {showRoles && (
            <div className="settings-roles-body">
              {/* Tuning describes a MODEL, not an endpoint, so these belong to
                  the chat assignment above rather than to the connection. A
                  role assigned its own model on this same endpoint keeps its
                  own numbers — which is the point: a small rerank model must
                  not inherit a 128k window because it shares a host. */}
              <Field label="Context window (tokens)" value={draft.contextWindow} onChange={(contextWindow) => set({ contextWindow })} placeholder="auto — asks the endpoint, else the preset default" type="number" />
              <Field label="Temperature" value={draft.temperature} onChange={(temperature) => set({ temperature })} placeholder="provider default" type="number" />
              <Field label="Max output tokens" value={draft.maxTokens} onChange={(maxTokens) => set({ maxTokens })} placeholder="provider default" type="number" />
              <Field label="Request timeout (seconds)" value={draft.timeoutSec} onChange={(timeoutSec) => set({ timeoutSec })} placeholder="300 — raise for local/slow models on large prompts" type="number" />
            </div>
          )}
        </div>

        <div className="settings-actions">
          <button
            className="primary"
            disabled={!draft.name.trim() || !draft.baseUrl.trim()}
            onClick={() => {
              postToExtension({
                type: 'settingsSaveProfile',
                original: draft.original,
                profile: fromDraft(draft),
                apiKey: draft.clearKey ? '' : draft.apiKey !== '' ? draft.apiKey : undefined,
              });
              openDraft(null);
            }}
          >
            Save
          </button>
          <button className="ghost" onClick={() => openDraft(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings">
      <div className="settings-header">
        <div>
          <div className="settings-title">Connections</div>
          <div className="settings-subtitle">
            Provider endpoints Heap Code connects to — local or cloud. Which model does what is
            below.
          </div>
        </div>
      </div>
      <div className="settings-profile-list">
        {data.profiles.map((p) => (
          <div key={p.name} className={`settings-profile${p.name === data.active ? ' active' : ''}`}>
            <div className="settings-profile-info">
              <span className="settings-profile-name">
                {p.name}
                {p.name === data.active && <span className="settings-active-badge">active</span>}
              </span>
              <span className="settings-profile-detail">
                {data.presets.find((x) => x.id === p.preset)?.label ?? p.preset} ·{' '}
                {p.model || 'no model'}
                {data.keySaved[p.name] ? ' · 🔑' : ''}
              </span>
            </div>
            <div className="settings-profile-actions">
              {p.name !== data.active && (
                <button
                  className="ghost"
                  title="Move chat to this connection"
                  onClick={() => postToExtension({ type: 'settingsActivateProfile', name: p.name })}
                >
                  Use
                </button>
              )}
              <button className="ghost" onClick={() => openDraft(toDraft(p))}>
                Edit
              </button>
              <button
                className="ghost danger"
                title="Delete connection"
                onClick={() => postToExtension({ type: 'settingsDeleteProfile', name: p.name })}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        className="settings-add"
        onClick={() => openDraft(newDraft(data.presets.find((p) => p.id === 'ollama') ?? data.presets[0]!))}
      >
        + Add connection
      </button>

      <div className="settings-section">
        <div className="settings-section-title">Model roles</div>
        <div className="settings-subtitle">
          One table for the whole app, not one per connection. Each role can run on any
          connection’s model, and switching what you chat with no longer changes the rest.
        </div>
        <div className="settings-roles-body">
          {MODEL_ROLES.map((role) => (
            <RoleRow
              key={role}
              role={role}
              assignment={data.roles[role]}
              summary={data.roleSummary[role]}
              connections={data.profiles.map((p) => p.name)}
              models={connectionModels}
              onRequestModels={requestModels}
              onChange={(assignment) =>
                postToExtension({
                  type: 'settingsSetRole',
                  role,
                  // An assignment with no model is not a state anything can
                  // run on, so it is sent as a clear instead.
                  assignment: assignment?.model ? assignment : undefined,
                })
              }
            />
          ))}
        </div>
      </div>
      <div className="settings-section">
        <div className="settings-section-title">Agent</div>
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={data.subAgentsEnabled}
            onChange={(e) => postToExtension({ type: 'settingsSetSubAgents', enabled: e.target.checked })}
          />
          <span>
            <strong>Sub-agent orchestration</strong>
            <div className="settings-subtitle">
              Let the agent delegate self-contained work to an isolated sub-agent (own context,
              optionally its own persona/model). Off by default — a new, autonomy-increasing
              capability.
            </div>
          </span>
        </label>
      </div>
      <p className="settings-note">
        API keys are stored in your OS keychain, never in settings files. Editor-level options
        (autocomplete, agent iterations, safe mode…) live in{' '}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            postToExtension({ type: 'openNativeSettings' });
          }}
        >
          VS Code settings
        </a>
        .
      </p>
    </div>
  );
}
