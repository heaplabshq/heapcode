import { useEffect, useRef, useState } from 'react';
import { useModal } from '../modal.js';
import {
  UI_MODEL_ROLES,
  type UiPreset,
  type UiProbeProviderParams,
  type UiProbeProviderResult,
  type UiProfile,
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
                        otherProfiles={s.profiles.map((o) => o.name).filter((n) => n !== p.name)}
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
                <Section title="Connectors">
                  <p className="hint">MCP servers this session can call tools on.</p>
                  {s.mcpServers.length === 0 ? (
                    <p className="hint">
                      None configured. Add them to <code>~/.heapcode/config.json</code> (<code>mcpServers</code>) or
                      this project&rsquo;s <code>.heapcode/mcp.json</code>.
                    </p>
                  ) : (
                    <ul className="rows">
                      {s.mcpServers.map((m) => (
                        <li key={m.name} className="row">
                          <span className={`badge ${m.connected ? 'badge-ok' : 'badge-off'}`}>
                            {m.connected ? 'connected' : 'not connected'}
                          </span>
                          <span className="row-name">{m.name}</span>
                          <span className="hint">{m.tools.length} tools</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
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
  otherProfiles,
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
  /** Sibling profile names, for "run this role on another provider". */
  otherProfiles: string[];
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
    maxTokens: profile.maxTokens ?? null,
    temperature: profile.temperature ?? null,
    roles: rolesOf(profile),
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

          <ModelRoles
            roles={draft.roles ?? {}}
            profiles={otherProfiles}
            onChange={(roles) => setDraft({ ...draft, roles })}
            listModels={listModels}
            ownProfile={profile.name}
          />

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

/** A profile's role overrides, flattened into the draft's `roles` map. */
function rolesOf(profile: UiProfile): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of UI_MODEL_ROLES) {
    for (const suffix of ['Model', 'Profile'] as const) {
      const key = `${role.key}${suffix}` as const;
      out[key] = profile[key] ?? '';
    }
  }
  return out;
}

/**
 * Per-role model overrides, collapsed by default.
 *
 * A profile is one endpoint with one chat model, but the agent does not only
 * chat: it merges edits with a fast-apply model, embeds and reranks for
 * semantic search, and writes per-chunk blurbs at index time. Those were
 * settable in the extension and in config.json but nowhere in the browser, so
 * anyone who wanted local embeddings behind a cloud agent had to leave the web
 * UI to arrange it — even though this host is the one running the index.
 *
 * Collapsed because most profiles never need any of it: everything here
 * inherits, and the placeholders say what from.
 */
function ModelRoles({
  roles,
  profiles,
  onChange,
  listModels,
  ownProfile,
}: {
  roles: Record<string, string>;
  profiles: string[];
  onChange(next: Record<string, string>): void;
  listModels?(profileName: string): Promise<string[]>;
  /** Whose endpoint a role uses when it is not redirected elsewhere. */
  ownProfile: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const set = (key: string, value: string): void => onChange({ ...roles, [key]: value });
  const overridden = Object.values(roles).filter(Boolean).length;

  return (
    <div className="roles">
      <button className="roles-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '▾' : '▸'} Model roles
        {overridden > 0 && <span className="badge badge-ok">{overridden} set</span>}
      </button>
      {open && (
        <div className="roles-body">
          {(['Core', 'Retrieval'] as const).map((group) => (
            <div key={group}>
              <div className="roles-group">{group}</div>
              {UI_MODEL_ROLES.filter((r) => r.group === group).map((role) => (
                <div key={role.key} className="role">
                  <span className="role-label">{role.label}</span>
                  <ModelInput
                    value={roles[`${role.key}Model`] ?? ''}
                    placeholder={role.hint}
                    aria-label={`${role.label} model`}
                    onChange={(v) => set(`${role.key}Model`, v)}
                    // The list has to come from wherever the role actually
                    // runs: redirect embeddings to a local Ollama and the
                    // models worth offering are that endpoint's, not this
                    // profile's.
                    listModels={() =>
                      listModels?.(roles[`${role.key}Profile`] || ownProfile) ?? Promise.resolve([])
                    }
                  />
                  {/* The second half of a role: run it against a different
                      profile's endpoint and key entirely — embeddings on a
                      local Ollama while the agent stays on a cloud model. */}
                  <select
                    className="select role-select"
                    value={roles[`${role.key}Profile`] ?? ''}
                    aria-label={`${role.label} profile`}
                    onChange={(e) => set(`${role.key}Profile`, e.target.value)}
                  >
                    <option value="">this profile</option>
                    {profiles.map((name) => (
                      <option key={name} value={name}>
                        on {name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Editor draft → the wire shape.
 *
 * `roles` is a nested map because that is what the form binds to; the protocol
 * carries the same thing flat (`agentModel`, `agentProfile`, …) because that is
 * what a stored profile looks like. Flattening here means neither side has to
 * hold the other's shape, and `roles` itself never crosses the wire.
 */
function toSaveParams(draft: UiProfileDraft): UiSaveProfileParams['profile'] {
  const { roles, ...rest } = draft;
  return { ...rest, ...(roles ?? {}) };
}
