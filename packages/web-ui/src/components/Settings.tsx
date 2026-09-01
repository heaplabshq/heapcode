import { useEffect, useRef, useState } from 'react';
import { useModal } from '../modal.js';
import {
  UI_MODEL_ROLES,
  type UiModelRole,
  type UiPreset,
  type UiProbeProviderParams,
  type UiProbeProviderResult,
  type UiMcpServer,
  type UiProfile,
  type UiRoleAssignment,
  type UiSaveProfileParams,
  type UiSettings,
} from '@heapcode/web-host/protocol';
import { ModelInput } from './ModelInput.js';

export interface SettingsProps {
  settings?: UiSettings;
  /** Opened via /context or the header meter: start on the active profile. */
  focus?: 'context';
  onClose(): void;
  onSetPersona(id: string): void;
  onToggleSubAgents(enabled: boolean): void;
  onToggleNativeTools(enabled: boolean): void;
  onSetWebSearch(patch: { provider?: string; enabled?: boolean; apiKey?: string }): void;
  onResetPermissions(): void;
  onUseProfile(name: string): void;
  onDeleteProfile(name: string): void;
  onSaveProfile(profile: UiSaveProfileParams['profile'], apiKey?: string): void;
  /** Assign a role, or clear it (no assignment) so it inherits again. */
  onSetRole(role: UiModelRole, assignment?: { connection: string; model: string }): void;
  /**
   * Model ids for one connection, for a role row's dropdown.
   *
   * Separate from `listModels` (which lists the connection being edited)
   * because a role row asks about a connection that is not the one in the
   * form, and one unreachable endpoint must cost only its own row.
   */
  listConnectionModels?(connection: string): Promise<string[]>;
  /** Add or replace an MCP server. `spec` is a URL or a command line. */
  onSaveMcpServer(name: string, spec: string): void;
  onDeleteMcpServer(name: string): void;
  /** Models a given profile's endpoint serves, for the role fields' type-ahead. */
  listModels?(profileName: string): Promise<string[]>;
  /** Tests an endpoint that isn't a saved profile yet, and reports what it serves. */
  probeProvider?(params: UiProbeProviderParams): Promise<UiProbeProviderResult>;
  /** Lazy, because both read files: only fetched when their page is opened. */
  loadSkills?(): Promise<string>;
  loadMemory?(): Promise<string>;
}

export interface UiProfileDraft {
  name: string;
  preset: string;
  baseUrl: string;
  model: string;
  /** `null` clears the override so the preset's default applies again. */
  contextWindow?: number | null;
  /** '' means automatic — the same "no override" the host stores as absent. */
  promptDetail?: string;
  maxTokens?: number | null;
  temperature?: number | null;
  /** `<role>Model` / `<role>Profile`; '' clears back to the inherited value. */
  roles?: Record<string, string>;
}

/** Left-nav entries, in the two groups the dialog shows them under. */
const PAGES = [
  { id: 'general', group: 'Settings', label: 'General', keywords: 'persona agent sub-agents native tool calling' },
  { id: 'providers', group: 'Settings', label: 'Providers', keywords: 'profile model api key base url context window tokens' },
  { id: 'search', group: 'Settings', label: 'Web search', keywords: 'brave tavily serper provider api key' },
  { id: 'permissions', group: 'Settings', label: 'Permissions', keywords: 'grants always allow reset' },
  { id: 'skills', group: 'Customize', label: 'Skills', keywords: 'skill instructions' },
  { id: 'connectors', group: 'Customize', label: 'Connectors', keywords: 'mcp servers tools' },
  { id: 'memory', group: 'Customize', label: 'Memory', keywords: 'heapcode.md project instructions' },
] as const;

type PageId = (typeof PAGES)[number]['id'];

/**
 * Settings as a two-column dialog: a filterable list of pages on the left, one
 * page at a time on the right.
 *
 * It used to be every section stacked in one scroller, which meant the thing
 * you opened it for was always somewhere in a column of five other things —
 * and adding a section made that worse for everything already there. Splitting
 * it also gives Skills, Connectors and Memory a home; they were reachable only
 * as slash commands that dumped a wall of text into the transcript.
 */
export function Settings(props: SettingsProps): JSX.Element {
  const s = props.settings;
  // `/context` and the context meter both land on the profile editor, which is
  // where the window size actually lives.
  const [page, setPage] = useState<PageId>(props.focus === 'context' ? 'providers' : 'general');
  const [query, setQuery] = useState('');

  const q = query.trim().toLowerCase();
  const shown = q
    ? PAGES.filter((p) => `${p.label} ${p.keywords}`.toLowerCase().includes(q))
    : PAGES;
  const groups = ['Settings', 'Customize'] as const;
  const dialog = useRef<HTMLDivElement>(null);
  useModal(dialog, props.onClose);

  return (
    <div className="modal-scrim" onClick={props.onClose}>
      <div
        className="modal modal-wide"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <nav className="settings-nav" aria-label="Settings sections">
          <input
            data-autofocus
            className="settings-search"
            value={query}
            placeholder="Search"
            aria-label="Search settings"
            onChange={(e) => setQuery(e.target.value)}
          />
          {groups.map((g) => {
            const items = shown.filter((p) => p.group === g);
            if (items.length === 0) return null;
            return (
              <div key={g}>
                <div className="settings-nav-group">{g}</div>
                {items.map((p) => (
                  <button
                    key={p.id}
                    className={`settings-nav-item ${page === p.id ? 'settings-nav-item-on' : ''}`}
                    onClick={() => setPage(p.id)}
                    aria-current={page === p.id}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            );
          })}
          {shown.length === 0 && <p className="hint settings-nav-empty">Nothing matches.</p>}
        </nav>

        <div className="settings-pane">
          <button className="icon-btn settings-close" onClick={props.onClose} aria-label="Close settings">
            ✕
          </button>

          {!s ? (
            // Placeholder fields rather than the word "Loading": the dialog is
            // a fixed height, so an empty pane reads as a broken settings
            // screen for however long the round trip takes.
            <div className="modal-body skeleton" aria-hidden="true">
              {[70, 45, 85, 60, 50].map((w, i) => (
                <div className="skeleton-line" key={i} style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : (
            <div className="modal-body">
              {page === 'general' && (
                <Section title="General">
                  <Field label="Persona">
                    <select className="select" value={s.persona} onChange={(e) => props.onSetPersona(e.target.value)}>
                      {s.personas.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <p className="hint">{s.personas.find((p) => p.id === s.persona)?.description}</p>

                  <Toggle
                    label="Sub-agents"
                    hint="Lets the agent hand off a self-contained sub-task to a fresh agent (delegate_task)."
                    checked={s.subAgents}
                    onChange={props.onToggleSubAgents}
                  />
                  <Toggle
                    label="Native tool calling"
                    hint="Turn off for endpoints that reject the tools parameter — the agent falls back to the text protocol."
                    checked={s.nativeToolCalls}
                    onChange={props.onToggleNativeTools}
                  />
                </Section>
              )}

              {page === 'providers' && (
                <Section title="Providers">
                  <ul className="rows">
                    {s.profiles.map((p) => (
                      <ProfileRow
                        key={p.name}
                        profile={p}
                        presets={s.presets?.length ? s.presets : FALLBACK_PRESETS}
                        startOpen={props.focus === 'context' && p.active}
                        onUse={() => props.onUseProfile(p.name)}
                        onDelete={() => props.onDeleteProfile(p.name)}
                        onSaveKey={(key) =>
                          props.onSaveProfile(
                            { name: p.name, preset: p.preset, baseUrl: p.baseUrl, model: p.model },
                            key,
                          )
                        }
                        onSaveProfile={(patch) => props.onSaveProfile(patch)}
                        listModels={props.listModels}
                        probeProvider={props.probeProvider}
                      />
                    ))}
                  </ul>
                  <AddProfile
                    presets={s.presets?.length ? s.presets : FALLBACK_PRESETS}
                    probeProvider={props.probeProvider}
                    onAdd={props.onSaveProfile}
                  />

                  {/* One table for the whole app, below the connections rather
                      than inside each of them. A role names a model; it is not
                      a property of an endpoint. */}
                  <h3 className="settings-subhead">Model roles</h3>
                  <p className="hint">
                    Each role can run on any connection&rsquo;s model. Switching what you chat with no longer
                    changes the rest.
                  </p>
                  <RoleTable
                    roles={s.roles ?? []}
                    connections={s.profiles}
                    onSetRole={props.onSetRole}
                    listModels={props.listConnectionModels ?? props.listModels}
                  />
                </Section>
              )}

              {page === 'search' && (
                <Section title="Web search">
                  <Field label="Provider">
                    <select
                      className="select"
                      value={s.webSearch.provider ?? ''}
                      onChange={(e) => props.onSetWebSearch({ provider: e.target.value })}
                    >
                      <option value="">(not configured)</option>
                      {s.webSearch.providers.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Toggle
                    label="Enabled"
                    hint={s.webSearch.hasKey ? 'An API key is stored.' : 'No API key stored — some providers need one.'}
                    checked={s.webSearch.enabled}
                    onChange={(enabled) => props.onSetWebSearch({ enabled })}
                  />
                  <SecretField
                    label="API key"
                    placeholder={s.webSearch.hasKey ? '•••••••• (stored)' : 'Paste a key to store it'}
                    onSave={(apiKey) => props.onSetWebSearch({ apiKey })}
                  />
                </Section>
              )}

              {page === 'connectors' && (
                <Connectors
                  servers={s.mcpServers}
                  onSave={props.onSaveMcpServer}
                  onDelete={props.onDeleteMcpServer}
                />
              )}

              {page === 'skills' && (
                <Section title="Skills">
                  <p className="hint">
                    Packaged instructions the agent can load on demand, from <code>.heapcode/skills/</code>.
                  </p>
                  <TextPane load={props.loadSkills} empty="No skills available." />
                </Section>
              )}

              {page === 'memory' && (
                <Section title="Memory">
                  <p className="hint">
                    Project instructions prepended to every task — <code>HEAPCODE.md</code> and{' '}
                    <code>.heapcode/memory.md</code>. Edit them in the workspace; this is what the agent currently sees.
                  </p>
                  <TextPane load={props.loadMemory} empty="No project instructions or memory configured." />
                </Section>
              )}

              {page === 'permissions' && (
                <Section title="Permissions">
                  <p className="hint">
                    Saved &ldquo;Always allow&rdquo; grants for this project. Clearing them means the agent asks again.
                  </p>
                  {s.permissionGrants.length === 0 ? (
                    <p className="hint">No saved grants.</p>
                  ) : (
                    <ul className="rows">
                      {s.permissionGrants.map((g) => (
                        <li key={g} className="row">
                          <code>{g}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                  <button className="btn btn-danger" onClick={props.onResetPermissions}>
                    Clear all grants
                  </button>
                </Section>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A page whose content is a block of host-formatted text (skills, memory).
 *
 * Fetched when the page is opened rather than with the rest of settings: both
 * of these read files off disk, and paying for them every time the dialog
 * opens would slow down the common case for two pages most visits never reach.
 */
function TextPane({ load, empty }: { load?(): Promise<string>; empty: string }): JSX.Element {
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!load) return;
    void load()
      .then(setText)
      .catch((err: Error) => setError(err.message));
  }, [load]);
  if (error) return <p className="banner-error">{error}</p>;
  if (text === undefined) return <p className="hint">Loading…</p>;
  return <pre className="settings-text">{text.trim() || empty}</pre>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange(v: boolean): void;
}): JSX.Element {
  return (
    <div className="field">
      <label className="toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

/**
 * A whole-number field that can also be *empty*.
 *
 * Empty is a real state, not zero: it means "no override, inherit the preset's
 * default", which is what `null` carries to the host. Binding a `number` here
 * would make clearing the box read as 0 and pin the context window to nothing.
 */
function NumberField({
  label,
  value,
  placeholder,
  onChange,
  step = 1,
}: {
  label: string;
  value?: number | null;
  placeholder: string;
  onChange(v: number | null): void;
  /** 0.1 for temperature; whole numbers everywhere else. */
  step?: number;
}): JSX.Element {
  return (
    <Field label={label}>
      <input
        className="card-input"
        type="number"
        min={0}
        step={step}
        inputMode="numeric"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (!raw) return onChange(null);
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) return onChange(null);
          // Fractional values are meaningful for temperature and nonsense for
          // token counts, so the step decides whether to round.
          onChange(step < 1 ? n : Math.floor(n) || null);
        }}
      />
    </Field>
  );
}

/** Write-only by construction: it has no value prop, so a key can never render. */
function SecretField({
  label,
  placeholder,
  onSave,
}: {
  label: string;
  placeholder: string;
  onSave(value: string): void;
}): JSX.Element {
  const [value, setValue] = useState('');
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="field-row">
        <input
          className="card-input"
          type="password"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
        />
        <button
          className="btn"
          disabled={!value.trim()}
          onClick={() => {
            onSave(value);
            setValue('');
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function ProfileRow({
  profile,
  presets,
  startOpen,
  onUse,
  onDelete,
  onSaveKey,
  onSaveProfile,
  listModels,
  probeProvider,
}: {
  profile: UiProfile;
  presets: UiPreset[];
  startOpen?: boolean;
  onUse(): void;
  onDelete(): void;
  onSaveKey(key: string): void;
  onSaveProfile(p: UiSaveProfileParams['profile']): void;
  listModels?(profileName: string): Promise<string[]>;
  probeProvider?: SettingsProps['probeProvider'];
}): JSX.Element {
  const [editing, setEditing] = useState(Boolean(startOpen));
  const probe = useProbe(probeProvider);
  const [draft, setDraft] = useState<UiProfileDraft>({
    name: profile.name,
    preset: profile.preset,
    baseUrl: profile.baseUrl,
    model: profile.model,
    contextWindow: profile.contextWindow ?? null,
    promptDetail: profile.promptTier ?? '',
    maxTokens: profile.maxTokens ?? null,
    temperature: profile.temperature ?? null,
  });

  return (
    <li className={`row row-block ${profile.active ? 'row-active' : ''}`}>
      <div className="row-main">
        <span className="row-name">
          {profile.active && <span className="badge badge-ok">active</span>} {profile.name}
        </span>
        <span className="hint">
          {profile.preset} · {profile.model} · {fmtTokens(profile.effectiveContextWindow)} ctx
          {profile.maxTokens ? ` · ${fmtTokens(profile.maxTokens)} out` : ''}
          {profile.hasKey ? ' · key stored' : ''}
        </span>
        <div className="row-actions">
          {!profile.active && (
            <button className="btn" onClick={onUse}>
              Use
            </button>
          )}
          <button className="btn" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close' : 'Edit'}
          </button>
          {!profile.active && (
            <button className="btn btn-danger" onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
      </div>

      {editing && (
        <div className="profile-edit">
          <p className="hint">{profile.baseUrl}</p>
          <Field label="Base URL">
            <input
              className="card-input"
              value={draft.baseUrl}
              onChange={(e) => {
                probe.reset();
                setDraft({ ...draft, baseUrl: e.target.value });
              }}
            />
          </Field>
          {probeProvider && (
            <ProbeButton
              probe={probe}
              disabled={!draft.baseUrl.trim()}
              params={{ preset: draft.preset, baseUrl: draft.baseUrl, useStoredKeyFor: profile.name }}
            />
          )}
          <Field label="Model">
            <ModelInput
              value={draft.model}
              aria-label="Model"
              onChange={(model) => setDraft({ ...draft, model })}
              // Untested: fall back to listing through the saved profile, which
              // is what this field has always done.
              models={probe.state === 'idle' ? undefined : probe.models}
              listModels={() => listModels?.(profile.name) ?? Promise.resolve([])}
            />
          </Field>
          <Field label="Preset">
            <select
              className="select"
              value={draft.preset}
              onChange={(e) => {
                const next = presets.find((p) => p.id === e.target.value);
                if (!next) return;
                const current = presets.find((p) => p.id === draft.preset);
                // Only follow the new preset's endpoint if the old one was still
                // its preset's default — never overwrite a URL the user set.
                const untouched = !draft.baseUrl || draft.baseUrl === current?.defaultBaseUrl;
                setDraft({ ...draft, preset: next.id, baseUrl: untouched ? next.defaultBaseUrl : draft.baseUrl });
              }}
            >
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.local ? ' (local)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <NumberField
            label="Context window (tokens)"
            value={draft.contextWindow}
            placeholder={`${profile.effectiveContextWindow} (from preset)`}
            onChange={(contextWindow) => setDraft({ ...draft, contextWindow })}
          />
          <p className="hint">
            Prompt + output the model can hold. Drives the usage meter and when the conversation is compacted — raise it
            to match what your endpoint really serves. Empty inherits the preset&rsquo;s.
          </p>
          <NumberField
            label="Max output tokens"
            value={draft.maxTokens}
            placeholder="provider default"
            onChange={(maxTokens) => setDraft({ ...draft, maxTokens })}
          />
          <p className="hint">Cap on a single reply. Raise it if long answers or large edits get cut off.</p>
          <NumberField
            label="Temperature"
            value={draft.temperature}
            placeholder="provider default"
            onChange={(temperature) => setDraft({ ...draft, temperature })}
            step={0.1}
          />

          <Field label="Prompt detail">
            <select
              className="select"
              value={draft.promptDetail ?? ''}
              aria-label="Prompt detail"
              onChange={(e) => setDraft({ ...draft, promptDetail: e.target.value })}
            >
              <option value="">Full — every section (default)</option>
              <option value="lean">Lean — the essential rules only</option>
              <option value="auto">Automatic — decide from the model</option>
            </select>
          </Field>
          <p className="hint">
            How much of the agent&rsquo;s instructions this model receives. Full is the default and the right choice
            for almost every profile. Lean is for a model that follows short instructions better. Automatic picks
            between them from the model&rsquo;s context window and whether it calls tools natively.
          </p>

          <div className="field-row">
            <button
              className="btn btn-primary"
              disabled={!draft.baseUrl.trim() || !draft.model.trim()}
              // Saving under the same name updates in place — `saveProfile`
              // upserts by name, so renaming here would create a second one.
              onClick={() => onSaveProfile(toSaveParams({ ...draft, name: profile.name }))}
            >
              Save changes
            </button>
          </div>
          <SecretField
            label="API key"
            placeholder={profile.hasKey ? '•••••••• (stored — paste to replace)' : 'Paste a key to store it'}
            onSave={onSaveKey}
          />
        </div>
      )}
    </li>
  );
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

/**
 * Only the fallback for a host too old to send its own list. The hardcoded
 * copy that used to live here had to match core's `PresetId` exactly and
 * silently drifted from it — a preset added in core simply never appeared in
 * the browser. `settings.presets` is the real source now.
 */
const FALLBACK_PRESETS: UiPreset[] = [
  { id: 'custom', label: 'Custom OpenAI-compatible endpoint', defaultBaseUrl: '', requiresApiKey: false, local: false },
];

/**
 * "Test connection", and the model list that comes back from it.
 *
 * Kept as one piece of state because they are one action: the answer to "does
 * this endpoint work" is the list of what it serves, and asking twice (once to
 * verify, once to populate the dropdown) would be two round-trips for one
 * question. The list is handed to ModelInput so picking a model is a choice
 * rather than a recall test — while still leaving it typeable, since endpoints
 * that serve models they refuse to enumerate are common.
 */
function useProbe(probe: SettingsProps['probeProvider']): {
  state: 'idle' | 'testing' | 'ok' | 'failed';
  models: string[];
  note?: string;
  run(params: UiProbeProviderParams): void;
  reset(): void;
} {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'failed'>('idle');
  const [models, setModels] = useState<string[]>([]);
  const [note, setNote] = useState<string>();

  return {
    state,
    models,
    note,
    reset: () => {
      setState('idle');
      setModels([]);
      setNote(undefined);
    },
    run: (params) => {
      if (!probe) return;
      setState('testing');
      setNote(undefined);
      void probe(params)
        .then((r) => {
          setModels(r.models);
          setState(r.ok ? 'ok' : 'failed');
          setNote(r.error ?? (r.ok ? `${r.models.length} models available.` : undefined));
        })
        .catch((err: Error) => {
          setState('failed');
          setNote(err.message);
        });
    },
  };
}

function ProbeButton({
  probe,
  params,
  disabled,
}: {
  probe: ReturnType<typeof useProbe>;
  params: UiProbeProviderParams;
  disabled?: boolean;
}): JSX.Element {
  return (
    <div className="field-row probe-row">
      <button className="btn" disabled={disabled || probe.state === 'testing'} onClick={() => probe.run(params)}>
        {probe.state === 'testing' ? 'Testing…' : 'Test connection'}
      </button>
      {probe.state === 'ok' && <span className="badge badge-ok">connected</span>}
      {probe.state === 'failed' && <span className="badge badge-off">failed</span>}
      {probe.note && <span className="hint probe-note">{probe.note}</span>}
    </div>
  );
}

function AddProfile({
  presets,
  probeProvider,
  onAdd,
}: {
  presets: UiPreset[];
  probeProvider?: SettingsProps['probeProvider'];
  onAdd(p: UiSaveProfileParams['profile'], key?: string): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const first = presets[0]!;
  const blank = (): UiProfileDraft => ({ name: '', preset: first.id, baseUrl: first.defaultBaseUrl, model: '' });
  const [draft, setDraft] = useState<UiProfileDraft>(blank);
  const [key, setKey] = useState('');
  const preset = presets.find((p) => p.id === draft.preset);
  const probe = useProbe(probeProvider);

  if (!open) {
    return (
      <button className="btn" onClick={() => setOpen(true)}>
        Add profile
      </button>
    );
  }

  const valid = draft.name.trim() && draft.baseUrl.trim() && draft.model.trim();

  return (
    <div className="add-profile">
      <Field label="Name">
        <input className="card-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </Field>
      <Field label="Preset">
        <select
          className="select"
          value={draft.preset}
          onChange={(e) => {
            const next = presets.find((p) => p.id === e.target.value);
            if (!next) return;
            // Follow the new preset's endpoint unless the user typed their own.
            const untouched = !draft.baseUrl || draft.baseUrl === preset?.defaultBaseUrl;
            setDraft({ ...draft, preset: next.id, baseUrl: untouched ? next.defaultBaseUrl : draft.baseUrl });
          }}
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
              {p.local ? ' (local)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Base URL">
        <input
          className="card-input"
          value={draft.baseUrl}
          placeholder={preset?.defaultBaseUrl || 'http://localhost:11434/v1'}
          onChange={(e) => {
            probe.reset(); // a result for the previous endpoint is worse than none
            setDraft({ ...draft, baseUrl: e.target.value });
          }}
        />
      </Field>
      <Field label={preset?.requiresApiKey ? 'API key' : 'API key (optional)'}>
        <input
          className="card-input"
          type="password"
          value={key}
          onChange={(e) => {
            probe.reset();
            setKey(e.target.value);
          }}
          autoComplete="off"
        />
      </Field>
      {preset?.apiKeyUrl && (
        <div className="hint">
          Get a key at{' '}
          <a href={preset.apiKeyUrl} target="_blank" rel="noreferrer noopener">
            {preset.apiKeyUrl}
          </a>
        </div>
      )}
      {probeProvider && (
        <ProbeButton
          probe={probe}
          disabled={!draft.baseUrl.trim()}
          params={{ preset: draft.preset, baseUrl: draft.baseUrl, apiKey: key || undefined }}
        />
      )}
      <Field label="Model">
        <ModelInput
          value={draft.model}
          aria-label="Model"
          placeholder={probe.models.length ? 'Pick or type a model id' : 'Test the connection to list models'}
          onChange={(model) => setDraft({ ...draft, model })}
          // Already fetched by the test above — hand it straight over rather
          // than making the field ask the endpoint a second time.
          models={probe.models}
        />
      </Field>
      <NumberField
        label="Context window (tokens, optional)"
        value={draft.contextWindow}
        placeholder="inherit from preset"
        onChange={(contextWindow) => setDraft({ ...draft, contextWindow })}
      />
      <NumberField
        label="Max output tokens (optional)"
        value={draft.maxTokens}
        placeholder="provider default"
        onChange={(maxTokens) => setDraft({ ...draft, maxTokens })}
      />
      <div className="field-row">
        <button
          className="btn btn-primary"
          disabled={!valid}
          onClick={() => {
            onAdd(toSaveParams(draft), key || undefined);
            setDraft(blank());
            setKey('');
            setOpen(false);
          }}
        >
          Save profile
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * MCP servers: what is connected, and a way to add one.
 *
 * This page used to be a list ending in "edit ~/.heapcode/config.json
 * yourself", which is the one thing a settings screen exists to save you
 * from. The CLI's `/mcp` said the same; only the extension had an add flow,
 * and it writes to VS Code's own settings, so what it added never showed up
 * here.
 *
 * One field, not a transport picker and three boxes. A server is either a URL
 * or a command line, and the string already says which — asking someone to
 * classify it first is asking them to tell you something you can see.
 */
function Connectors({
  servers,
  onSave,
  onDelete,
}: {
  servers: UiMcpServer[];
  onSave(name: string, spec: string): void;
  onDelete(name: string): void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [editing, setEditing] = useState<string>();

  const add = (): void => {
    if (!name.trim() || !spec.trim()) return;
    onSave(name.trim(), spec.trim());
    setName('');
    setSpec('');
  };

  return (
    <Section title="Connectors">
      <p className="hint">MCP servers this session can call tools on.</p>

      {servers.length > 0 && (
        <ul className="rows">
          {servers.map((m) => (
            <li key={m.name} className="row row-block">
              <div className="row-main">
                <span className={`badge ${m.connected ? 'badge-ok' : 'badge-off'}`}>
                  {m.connected ? 'connected' : 'not connected'}
                </span>
                <span className="row-name">{m.name}</span>
                <span className="hint">{m.tools.length} tools</span>
                {/* Shown, never written: `.heapcode/mcp.json` is meant to be
                    committed, and a settings panel should not edit a file
                    under version control on someone's behalf. */}
                {m.project ? (
                  <span className="hint">from this project&rsquo;s .heapcode/mcp.json</span>
                ) : (
                  <div className="row-actions">
                    <button className="btn" onClick={() => setEditing(editing === m.name ? undefined : m.name)}>
                      {editing === m.name ? 'Close' : 'Edit'}
                    </button>
                    <button className="btn btn-danger" onClick={() => onDelete(m.name)}>
                      Remove
                    </button>
                  </div>
                )}
              </div>
              {m.spec && <p className="hint mono-hint">{m.spec}</p>}
              {editing === m.name && !m.project && (
                <EditServer
                  initial={m.spec ?? ''}
                  onSave={(next) => {
                    onSave(m.name, next);
                    setEditing(undefined);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <Field label="Name">
        <input
          className="input"
          value={name}
          placeholder="filesystem"
          aria-label="MCP server name"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Command or URL">
        <input
          className="input"
          value={spec}
          placeholder="npx -y @modelcontextprotocol/server-filesystem /path — or https://…"
          aria-label="MCP server command or URL"
          onChange={(e) => setSpec(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
      </Field>
      <p className="hint">
        A URL is a remote server; anything else is run as a local command. Its tools go through the same permission
        prompts as everything else.
      </p>
      <div className="field-row">
        <button className="btn btn-primary" disabled={!name.trim() || !spec.trim()} onClick={add}>
          Add server
        </button>
      </div>
    </Section>
  );
}

/** The one editable thing about a stored server: what it points at. */
function EditServer({ initial, onSave }: { initial: string; onSave(spec: string): void }): JSX.Element {
  const [spec, setSpec] = useState(initial);
  return (
    <div className="profile-edit">
      <Field label="Command or URL">
        <input
          className="input"
          value={spec}
          aria-label="Edit MCP server command or URL"
          onChange={(e) => setSpec(e.target.value)}
        />
      </Field>
      <div className="field-row">
        <button className="btn btn-primary" disabled={!spec.trim()} onClick={() => onSave(spec.trim())}>
          Save
        </button>
      </div>
    </div>
  );
}

/**
 * The global role table: which model on which connection serves each role.
 *
 * It used to be a collapsed block *inside every profile*, with a model box and
 * a "this profile" dropdown per role. That shape had two costs. Answering
 * "what runs rerank?" meant following the dropdown to another profile and
 * reading its field for the same role, which might itself inherit. And because
 * the block belonged to a profile, switching profiles silently swapped all
 * seven answers.
 *
 * Now there is one table. Each row states the resolved outcome — computed by
 * the host, so the CLI and the extension say the same thing — and lets the
 * model be picked from any connection.
 */
function RoleTable({
  roles,
  connections,
  onSetRole,
  listModels,
}: {
  roles: UiRoleAssignment[];
  connections: UiProfile[];
  onSetRole(role: UiModelRole, assignment?: { connection: string; model: string }): void;
  listModels?(connection: string): Promise<string[]>;
}): JSX.Element {
  return (
    <div className="roles-body">
      {(['Core', 'Retrieval'] as const).map((group) => (
        <div key={group}>
          <div className="roles-group">{group}</div>
          {UI_MODEL_ROLES.filter((r) => r.group === group).map((meta) => {
            const assignment = roles.find((r) => r.role === meta.key);
            return (
              <RoleRow
                key={meta.key}
                meta={meta}
                assignment={assignment}
                connections={connections}
                onSetRole={onSetRole}
                listModels={listModels}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * One role: what serves it, and the two controls that change it.
 *
 * The connection and the model are held locally until a model is settled,
 * which the first version got wrong in a way that made the row look broken.
 * It derived the connection straight from the stored assignment and, for a
 * role that was still inheriting, sent a clear on every change — so picking a
 * different endpoint stored nothing, the select snapped back to the one chat
 * was on, and the only models you could ever see were that endpoint's. There
 * was no order of operations that worked: you cannot name a model on an
 * endpoint you cannot select first.
 */
function RoleRow({
  meta,
  assignment,
  connections,
  onSetRole,
  listModels,
}: {
  meta: (typeof UI_MODEL_ROLES)[number];
  assignment?: UiRoleAssignment;
  connections: UiProfile[];
  onSetRole(role: UiModelRole, next?: { connection: string; model: string }): void;
  listModels?(connection: string): Promise<string[]>;
}): JSX.Element {
  const fallback = connections.find((c) => c.active)?.name ?? connections[0]?.name ?? '';
  const [connection, setConnection] = useState(assignment?.connection ?? fallback);
  const [draft, setDraft] = useState(assignment?.model ?? '');

  // Re-sync when the stored assignment changes underneath — a save round-trips
  // through the host and comes back, and other rows can move this one (setting
  // chat changes what an inheriting row resolves to).
  const stored = `${assignment?.connection ?? ''}\u0000${assignment?.model ?? ''}`;
  const lastStored = useRef(stored);
  if (lastStored.current !== stored) {
    lastStored.current = stored;
    setConnection(assignment?.connection ?? fallback);
    setDraft(assignment?.model ?? '');
  }

  const commit = (model: string): void => {
    const next = model.trim();
    if (next === (assignment?.model ?? '') && connection === (assignment?.connection ?? fallback)) return;
    onSetRole(meta.key, next ? { connection, model: next } : undefined);
  };

  return (
    <div className="role">
      <span className="role-label">{meta.label}</span>
      <ModelInput
        // Remounted per connection: the type-ahead caches the first list it
        // fetched, so without this a row that switched endpoint would keep
        // suggesting the previous one's models.
        key={connection}
        value={draft}
        // The resolved answer, so an inheriting row says what it inherited
        // rather than only what it would inherit from.
        placeholder={assignment?.summary ?? meta.hint}
        aria-label={`${meta.label} model`}
        onChange={setDraft}
        onCommit={commit}
        listModels={() => listModels?.(connection) ?? Promise.resolve([])}
      />
      <select
        className="select role-select"
        value={connection}
        aria-label={`${meta.label} connection`}
        onChange={(e) => {
          setConnection(e.target.value);
          // The model goes with it. A model id means nothing on an endpoint
          // that does not serve it, so an assignment that had one is cleared
          // back to inheriting until a model on the new endpoint is picked —
          // rather than left naming something that would fail at request time.
          setDraft('');
          if (assignment?.model) onSetRole(meta.key, undefined);
        }}
      >
        {connections.map((p) => (
          <option key={p.name} value={p.name}>
            on {p.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Editor draft → the wire shape.
 *
 * Roles are not in here any more: they are one global table (`ui/setRole`),
 * not fields on a profile, so this carries only the connection and its chat
 * model.
 */
function toSaveParams(draft: UiProfileDraft): UiSaveProfileParams['profile'] {
  const { promptDetail, ...rest } = draft;
  return {
    ...rest,
    // '' is the editor's default, which the host stores as the absence of the
    // field rather than as a written-out 'full' — `null` is how a patch says
    // "clear it", the same as the numeric overrides.
    promptTier: promptDetail === 'lean' || promptDetail === 'auto' ? promptDetail : null,
  };
}
