import { useState } from 'react';
import type { UiProfile, UiSettings } from '@heapcode/web-host/protocol';

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
  onSaveProfile(profile: UiProfileDraft, apiKey?: string): void;
}

export interface UiProfileDraft {
  name: string;
  preset: string;
  baseUrl: string;
  model: string;
  /** `null` clears the override so the preset's default applies again. */
  contextWindow?: number | null;
  maxTokens?: number | null;
}

export function Settings(props: SettingsProps): JSX.Element {
  const s = props.settings;

  return (
    <div className="modal-scrim" onClick={props.onClose}>
      <div className="modal" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={props.onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        {!s ? (
          <div className="modal-body">Loading…</div>
        ) : (
          <div className="modal-body">
            <Section title="Agent">
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

            <Section title="Provider profiles">
              <ul className="rows">
                {s.profiles.map((p) => (
                  <ProfileRow
                    key={p.name}
                    profile={p}
                    startOpen={props.focus === 'context' && p.active}
                    onUse={() => props.onUseProfile(p.name)}
                    onDelete={() => props.onDeleteProfile(p.name)}
                    onSaveKey={(key) =>
                      props.onSaveProfile(
                        { name: p.name, preset: p.preset, baseUrl: p.baseUrl, model: p.model },
                        key,
                      )
                    }
                    onSaveProfile={(draft) => props.onSaveProfile(draft)}
                  />
                ))}
              </ul>
              <AddProfile onAdd={props.onSaveProfile} />
            </Section>

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

            <Section title="MCP servers">
              {s.mcpServers.length === 0 ? (
                <p className="hint">
                  None configured. Add them to <code>~/.heapcode/config.json</code> (<code>mcpServers</code>) or this
                  project&rsquo;s <code>.heapcode/mcp.json</code>.
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
          </div>
        )}
      </div>
    </div>
  );
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
}: {
  label: string;
  value?: number | null;
  placeholder: string;
  onChange(v: number | null): void;
}): JSX.Element {
  return (
    <Field label={label}>
      <input
        className="card-input"
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (!raw) return onChange(null);
          const n = Number(raw);
          onChange(Number.isFinite(n) && n > 0 ? Math.floor(n) : null);
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
  startOpen,
  onUse,
  onDelete,
  onSaveKey,
  onSaveProfile,
}: {
  profile: UiProfile;
  startOpen?: boolean;
  onUse(): void;
  onDelete(): void;
  onSaveKey(key: string): void;
  onSaveProfile(p: UiProfileDraft): void;
}): JSX.Element {
  const [editing, setEditing] = useState(Boolean(startOpen));
  const [draft, setDraft] = useState<UiProfileDraft>({
    name: profile.name,
    preset: profile.preset,
    baseUrl: profile.baseUrl,
    model: profile.model,
    contextWindow: profile.contextWindow ?? null,
    maxTokens: profile.maxTokens ?? null,
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
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            />
          </Field>
          <Field label="Model">
            <input
              className="card-input"
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            />
          </Field>
          <Field label="Preset">
            <select
              className="select"
              value={draft.preset}
              onChange={(e) => setDraft({ ...draft, preset: e.target.value })}
            >
              {PRESETS.map((p) => (
                <option key={p} value={p}>
                  {p}
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
          <div className="field-row">
            <button
              className="btn btn-primary"
              disabled={!draft.baseUrl.trim() || !draft.model.trim()}
              // Saving under the same name updates in place — `saveProfile`
              // upserts by name, so renaming here would create a second one.
              onClick={() => onSaveProfile({ ...draft, name: profile.name })}
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
 * Must match core's `PresetId` exactly — the host rejects anything else, and
 * "azure" (the real id is `azure-openai`) used to be silently downgraded to
 * the "custom" preset's capabilities.
 */
const PRESETS = [
  'openai',
  'ollama',
  'azure-openai',
  'openrouter',
  'together',
  'groq',
  'nvidia-nim',
  'lmstudio',
  'vllm',
  'localai',
  'custom',
];

function AddProfile({ onAdd }: { onAdd(p: UiProfileDraft, key?: string): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<UiProfileDraft>({ name: '', preset: 'openai', baseUrl: '', model: '' });
  const [key, setKey] = useState('');

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
        <select className="select" value={draft.preset} onChange={(e) => setDraft({ ...draft, preset: e.target.value })}>
          {PRESETS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Base URL">
        <input
          className="card-input"
          value={draft.baseUrl}
          placeholder="http://localhost:11434/v1"
          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
        />
      </Field>
      <Field label="Model">
        <input className="card-input" value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
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
      <Field label="API key (optional)">
        <input className="card-input" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
      </Field>
      <div className="field-row">
        <button
          className="btn btn-primary"
          disabled={!valid}
          onClick={() => {
            onAdd(draft, key || undefined);
            setDraft({ name: '', preset: 'openai', baseUrl: '', model: '' });
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
