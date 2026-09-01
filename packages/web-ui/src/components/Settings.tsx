import { useEffect, useId, useRef, useState } from 'react';
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
import { markHue } from '../mark.js';
import { Empty } from './Empty.js';

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
  { id: 'general', group: 'General', label: 'General', icon: 'sliders', keywords: 'persona agent sub-agents native tool calling' },
  { id: 'providers', group: 'General', label: 'Providers', icon: 'plug', keywords: 'profile model api key base url context window tokens' },
  { id: 'search', group: 'General', label: 'Web search', icon: 'globe', keywords: 'brave tavily serper provider api key' },
  { id: 'permissions', group: 'General', label: 'Permissions', icon: 'shield', keywords: 'grants always allow reset' },
  { id: 'skills', group: 'Workspace', label: 'Skills', icon: 'sparkles', keywords: 'skill instructions' },
  { id: 'connectors', group: 'Workspace', label: 'Connectors', icon: 'link', keywords: 'mcp servers tools' },
  { id: 'memory', group: 'Workspace', label: 'Memory', icon: 'book', keywords: 'heapcode.md project instructions' },
] as const;

/** Inline SVGs so the nav can carry icons without pulling in an icon set. */
const ICONS: Record<string, JSX.Element> = {
  sliders: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2 4h7M2 8h4M2 12h9" strokeLinecap="round" />
      <circle cx="11.5" cy="4" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="13" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  plug: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M9 2v3M6 2v3" strokeLinecap="round" />
      <path d="M5 5h5v2a3 3 0 0 1-3 3H6a3 3 0 0 1-1-1V5Z" strokeLinejoin="round" />
      <path d="M7.5 10v4" strokeLinecap="round" />
    </svg>
  ),
  globe: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.5 2.4 5.5S9.6 12 8 13.5C6.4 12 5.6 10 5.6 8S6.4 4 8 2.5Z" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 2 3 4v4c0 3 2.2 5.2 5 6 2.8-.8 5-3 5-6V4l-5-2Z" strokeLinejoin="round" />
      <path d="M6 8.2 7.4 9.6 10 6.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  sparkles: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 2.5 9 6l3.5 1L9 8l-1 3.5L7 8l-3.5-1L7 6l1-3.5Z" strokeLinejoin="round" />
      <path d="M12.5 11.5l.4 1.4 1.4.4-1.4.4-.4 1.4-.4-1.4-1.4-.4 1.4-.4.4-1.4Z" strokeLinejoin="round" />
    </svg>
  ),
  link: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6.5 9.5 9.5 6.5" strokeLinecap="round" />
      <path d="M7 4.5 8 3.5a2.5 2.5 0 0 1 3.5 3.5l-1 1" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 11.5 8 12.5a2.5 2.5 0 0 1-3.5-3.5l1-1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  book: (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M3 3.5C3 2.7 3.7 2 4.5 2H13v10H4.5C3.7 12 3 12.7 3 13.5V3.5Z" strokeLinejoin="round" />
      <path d="M3 13.5C3 12.7 3.7 12 4.5 12H13" />
    </svg>
  ),
};

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
  const groups = ['General', 'Workspace'] as const;
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
            placeholder="Search settings"
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
                    <span className="settings-nav-icon">{ICONS[p.icon]}</span>
                    {p.label}
                  </button>
                ))}
              </div>
            );
          })}
          {shown.length === 0 && <p className="hint settings-nav-empty">Nothing matches.</p>}
        </nav>

        <div className="settings-pane">
          <div className="settings-pane-head">
            <h2>{PAGES.find((p) => p.id === page)?.label}</h2>
            <button className="icon-btn" onClick={props.onClose} aria-label="Close settings">
              ✕
            </button>
          </div>

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
                <Section description="How the agent behaves on every task.">
                  <Group>
                    <SettingRow label="Persona" hint={s.personas.find((p) => p.id === s.persona)?.description}>
                      <select
                        className="select"
                        aria-label="Persona"
                        value={s.persona}
                        onChange={(e) => props.onSetPersona(e.target.value)}
                      >
                        {s.personas.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </SettingRow>
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
                  </Group>
                </Section>
              )}

              {page === 'providers' && (
                <Section description="Model endpoints this workspace can reach, and which model serves each role.">
                  <Block
                    title="Connections"
                    hint="Where the models come from. Chat runs on the active one."
                  >
                  <ul className="conn-list">
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
                  </Block>

                  {/* One table for the whole app, below the connections rather
                      than inside each of them. A role names a model; it is not
                      a property of an endpoint. */}
                  <Block
                    title="Model roles"
                    hint="Each role can run on any connection’s model. Switching what you chat with no longer changes the rest."
                  >
                    <RoleTable
                      roles={s.roles ?? []}
                      connections={s.profiles}
                      onSetRole={props.onSetRole}
                      listModels={props.listConnectionModels ?? props.listModels}
                    />
                  </Block>
                </Section>
              )}

              {page === 'search' && (
                <Section description="Let the agent look things up on the web.">
                  <Group>
                    <SettingRow label="Provider" hint="Which search API the agent queries.">
                      <select
                        className="select"
                        aria-label="Provider"
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
                    </SettingRow>
                    <Toggle
                      label="Enabled"
                      hint="Adds a web_search tool to the agent. Off means it works from the repository alone."
                      checked={s.webSearch.enabled}
                      onChange={(enabled) => props.onSetWebSearch({ enabled })}
                    />
                    <SecretField
                      label="API key"
                      hint={
                        s.webSearch.hasKey
                          ? 'A key is stored. Paste a new one to replace it.'
                          : 'No key stored — most providers need one.'
                      }
                      placeholder={s.webSearch.hasKey ? '•••••••• (stored)' : 'Paste a key to store it'}
                      onSave={(apiKey) => props.onSetWebSearch({ apiKey })}
                    />
                  </Group>
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
                <Section description="Packaged instructions the agent can load on demand, from .heapcode/skills/.">
                  <TextPane load={props.loadSkills} empty="No skills available." />
                </Section>
              )}

              {page === 'memory' && (
                <Section
                  description="Project instructions prepended to every task — HEAPCODE.md and .heapcode/memory.md. Edit them in the workspace; this is what the agent currently sees."
                >
                  <TextPane load={props.loadMemory} empty="No project instructions or memory configured." />
                </Section>
              )}

              {page === 'permissions' && (
                <Section description="Saved “Always allow” grants for this project. Clearing them means the agent asks again.">
                  {s.permissionGrants.length === 0 ? (
                    <Empty>Nothing is pre-approved. The agent asks before every action that needs permission.</Empty>
                  ) : (
                    <ul className="rows">
                      {s.permissionGrants.map((g) => (
                        <li key={g} className="row grant-row">
                          <code>{g}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* Set apart rather than sitting under the list as one more
                      button: it undoes every row above it at once. */}
                  <div className="danger-zone">
                    <div className="setting-row-text">
                      <span className="setting-row-label">Reset permissions</span>
                      <p className="setting-row-hint">
                        Forgets every grant above. Nothing already done is undone — the agent simply starts asking
                        again.
                      </p>
                    </div>
                    <button
                      className="btn btn-danger"
                      disabled={s.permissionGrants.length === 0}
                      onClick={props.onResetPermissions}
                    >
                      Clear all grants
                    </button>
                  </div>
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
  // Skeleton rather than the word "Loading": these two pages are a wall of
  // text, and a one-line "Loading…" in a tall pane reads as an empty page.
  if (text === undefined) {
    return (
      <div className="skeleton" aria-label="Loading" aria-busy="true">
        {[92, 78, 84, 60].map((w, i) => (
          <div className="skeleton-line" key={i} style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }
  if (!text.trim()) return <Empty>{empty}</Empty>;
  return <pre className="settings-text">{text.trim()}</pre>;
}

/**
 * A bordered card of setting rows, hairline-divided.
 *
 * Controls used to sit loose in the page body, which left every page reading
 * as a column of unrelated widgets. Grouping them onto one surface makes the
 * page's shape visible before any of the labels are read.
 */
function Group({ label, children }: { label?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="settings-group-wrap">
      {label && <div className="settings-group-label">{label}</div>}
      <div className="settings-group">{children}</div>
    </div>
  );
}

/**
 * One setting: what it is and what it does on the left, the control on the
 * right.
 *
 * The explanation sits under the label rather than under the control, so
 * running down the left edge answers "what is on this page" without reading
 * past the widgets.
 */
function SettingRow({
  label,
  hint,
  stacked,
  children,
}: {
  label: string;
  hint?: string;
  /** For controls too wide to share a line — the control drops below. */
  stacked?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className={stacked ? 'setting-row setting-row-stacked' : 'setting-row'}>
      <div className="setting-row-text">
        <span className="setting-row-label">{label}</span>
        {hint && <p className="setting-row-hint">{hint}</p>}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

/**
 * A titled part of a page, for the pages that hold more than one idea.
 *
 * Providers carries two — the connections and the role table — and they used
 * to be separated by nothing but a bold line, so the role rows read as more
 * fields belonging to the connection above them.
 */
function Block({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="settings-block">
      <h3 className="settings-block-title">{title}</h3>
      {hint && <p className="settings-block-hint">{hint}</p>}
      {children}
    </section>
  );
}

function Section({
  description,
  children,
}: {
  description?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="settings-section">
      {description && (
        <div className="settings-section-head">
          <p className="settings-section-desc">{description}</p>
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A stacked label + control, with the explanation attached to it.
 *
 * `hint` is deliberately outside the `<label>`: a paragraph inside it would
 * become part of the control's accessible name, so a screen reader would read
 * the whole explanation back as the field's label.
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="field">
      <label className="field-inner">
        <span className="field-label">{label}</span>
        {children}
      </label>
      {hint && <p className="field-hint">{hint}</p>}
    </div>
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
  // `htmlFor` rather than wrapping: the label owns only the name, so the hint
  // beside it stays out of the checkbox's accessible name.
  const id = useId();
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <label className="setting-row-label" htmlFor={id}>
          {label}
        </label>
        {hint && <p className="setting-row-hint">{hint}</p>}
      </div>
      <div className="setting-row-control">
        <span className="switch">
          <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
        </span>
      </div>
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
  hint,
  value,
  placeholder,
  onChange,
  step = 1,
}: {
  label: string;
  hint?: string;
  value?: number | null;
  placeholder: string;
  onChange(v: number | null): void;
  /** 0.1 for temperature; whole numbers everywhere else. */
  step?: number;
}): JSX.Element {
  return (
    <Field label={label} hint={hint}>
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
  hint,
  placeholder,
  onSave,
}: {
  label: string;
  hint?: string;
  placeholder: string;
  onSave(value: string): void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const id = useId();
  return (
    <div className="setting-row setting-row-stacked">
      <div className="setting-row-text">
        <label className="setting-row-label" htmlFor={id}>
          {label}
        </label>
        {hint && <p className="setting-row-hint">{hint}</p>}
      </div>
      <div className="setting-row-control field-row">
        <input
          id={id}
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
    <li className={profile.active ? 'conn conn-active' : 'conn'}>
      <div className="conn-head">
        {/* The endpoint's initial, so a list of four connections is scannable
            by shape before any of the names are read. */}
        <span className="conn-mark" style={{ '--mark-h': markHue(profile.name) } as React.CSSProperties} aria-hidden="true">
          {profile.name.slice(0, 1)}
        </span>
        <div className="conn-id">
          <div className="conn-title">
            <span className="conn-name">{profile.name}</span>
            {profile.active && <span className="badge badge-active">active</span>}
            {profile.preset !== profile.name && <span className="conn-preset">{profile.preset}</span>}
          </div>
          <span className="conn-url">{profile.baseUrl}</span>
        </div>
        <div className="conn-actions">
          {!profile.active && (
            <button className="btn btn-ghost" onClick={onUse}>
              Use
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close' : 'Edit'}
          </button>
          {!profile.active && (
            <button className="btn btn-ghost btn-ghost-danger" onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
      </div>

      {/* The four numbers that decide how this endpoint behaves, each under
          its own name. They used to be one dim dot-separated sentence, which
          is unreadable at four facts and unparseable at five. */}
      <dl className="conn-facts">
        <Fact label="Model" value={profile.model || 'not set'} dim={!profile.model} />
        <Fact label="Context" value={`${fmtTokens(profile.effectiveContextWindow)} tokens`} />
        <Fact
          label="Max output"
          value={profile.maxTokens ? `${fmtTokens(profile.maxTokens)} tokens` : 'provider default'}
          dim={!profile.maxTokens}
        />
        <Fact label="API key" value={profile.hasKey ? 'stored' : 'none'} dim={!profile.hasKey} />
      </dl>

      {editing && (
        <div className="profile-edit">
          <div className="form-head">Edit connection</div>
          <Field label="Base URL" hint={draft.baseUrl === profile.baseUrl ? undefined : `Saved: ${profile.baseUrl}`}>
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

          {/* The three numeric overrides share a row: they are the same kind
              of answer — a number, or nothing at all — and stacking them made
              the editor twice as long as the decisions in it. */}
          <div className="field-grid">
            <NumberField
              label="Context window (tokens)"
              hint="Prompt + output the model can hold. Drives the usage meter and when the conversation is compacted. Empty inherits the preset’s."
              value={draft.contextWindow}
              placeholder={`${profile.effectiveContextWindow} (from preset)`}
              onChange={(contextWindow) => setDraft({ ...draft, contextWindow })}
            />
            <NumberField
              label="Max output tokens"
              hint="Cap on a single reply. Raise it if long answers or large edits get cut off."
              value={draft.maxTokens}
              placeholder="provider default"
              onChange={(maxTokens) => setDraft({ ...draft, maxTokens })}
            />
            <NumberField
              label="Temperature"
              hint="Higher wanders more. Leave empty unless the endpoint needs it."
              value={draft.temperature}
              placeholder="provider default"
              onChange={(temperature) => setDraft({ ...draft, temperature })}
              step={0.1}
            />
          </div>

          <Field
            label="Prompt detail"
            hint="How much of the agent’s instructions this model receives. Full is the default and the right choice for almost every profile. Lean is for a model that follows short instructions better. Automatic picks between them from the model’s context window and whether it calls tools natively."
          >
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

          <SecretField
            label="API key"
            hint={profile.hasKey ? 'A key is stored. Paste a new one to replace it.' : 'Stored outside this project.'}
            placeholder={profile.hasKey ? '•••••••• (stored — paste to replace)' : 'Paste a key to store it'}
            onSave={onSaveKey}
          />

          {/* Pinned under the form rather than mid-column: it is the one
              control that ends the edit, so it should be the last thing. */}
          <div className="form-actions">
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
        </div>
      )}
    </li>
  );
}

/** One labelled fact in a connection's summary strip. */
function Fact({ label, value, dim }: { label: string; value: string; dim?: boolean }): JSX.Element {
  return (
    <div className={dim ? 'conn-fact conn-fact-dim' : 'conn-fact'}>
      <dt>{label}</dt>
      <dd title={value}>{value}</dd>
    </div>
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
      <button className="conn-add" onClick={() => setOpen(true)}>
        + Add connection
      </button>
    );
  }

  const valid = draft.name.trim() && draft.baseUrl.trim() && draft.model.trim();

  return (
    <div className="add-profile">
      <div className="form-head">New connection</div>
      <Field label="Name" hint="What this endpoint is called in the picker and in the role table.">
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
      <div className="field-grid">
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
      </div>
      <div className="form-actions">
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
          Save connection
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
    <Section description="MCP servers this session can call tools on.">
      {servers.length === 0 && (
        <Empty>No connectors yet. Add one below and its tools join the agent&rsquo;s toolbox.</Empty>
      )}
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

      <div className="settings-card">
        <div className="form-head">Add a server</div>
        <Field label="Name">
          <input
            className="card-input"
            value={name}
            placeholder="filesystem"
            aria-label="MCP server name"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Command or URL">
          <input
            className="card-input"
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
        <div className="form-actions">
          <button className="btn btn-primary" disabled={!name.trim() || !spec.trim()} onClick={add}>
            Add server
          </button>
        </div>
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
          className="card-input"
          value={spec}
          aria-label="Edit MCP server command or URL"
          onChange={(e) => setSpec(e.target.value)}
        />
      </Field>
      <div className="form-actions">
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
    <div className="roles-body settings-group">
      {/* Column headers, because three controls in a row with no headings is
          a form, and this is a table — the same question answered eight times. */}
      <div className="roles-head" aria-hidden="true">
        <span>Role</span>
        <span>Model</span>
        <span>Connection</span>
      </div>
      {(['Core', 'Retrieval'] as const).map((group) => (
        <div className="roles-section" key={group}>
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
      {/* Only where the list above cannot be trusted to be complete. For
          embeddings it is not: a provider's /v1/models is a chat catalogue,
          and OpenRouter leaves its embedding models out of it entirely. */}
      {meta.note && <p className="hint role-note">{meta.note}</p>}
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
