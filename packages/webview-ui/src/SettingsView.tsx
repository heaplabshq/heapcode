import { useState } from 'react';
import type { ProviderProfileConfig, SettingsPresetInfo } from '@heapcode/core';
import { postToExtension } from './vscodeApi.js';

export interface SettingsData {
  profiles: ProviderProfileConfig[];
  active: string;
  presets: SettingsPresetInfo[];
  keySaved: Record<string, boolean>;
}

/** Working copy of a profile being edited; strings throughout for form binding. */
interface Draft {
  /** Name before editing began; undefined = new profile. */
  original?: string;
  name: string;
  preset: string;
  baseUrl: string;
  model: string;
  editModel: string;
  applyModel: string;
  completionModel: string;
  agentModel: string;
  embeddingsModel: string;
  rerankModel: string;
  /** Name of another configured profile to run this role on entirely — '' = this profile. */
  editProfile: string;
  applyProfile: string;
  completionProfile: string;
  agentProfile: string;
  embeddingsProfile: string;
  rerankProfile: string;
  contextWindow: string;
  temperature: string;
  maxTokens: string;
  /** Seconds, for form binding — converted to/from timeoutMs (ms). */
  timeoutSec: string;
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
    editModel: p.editModel ?? '',
    applyModel: p.applyModel ?? '',
    completionModel: p.completionModel ?? '',
    agentModel: p.agentModel ?? '',
    embeddingsModel: p.embeddingsModel ?? '',
    rerankModel: p.rerankModel ?? '',
    editProfile: p.editProfile ?? '',
    applyProfile: p.applyProfile ?? '',
    completionProfile: p.completionProfile ?? '',
    agentProfile: p.agentProfile ?? '',
    embeddingsProfile: p.embeddingsProfile ?? '',
    rerankProfile: p.rerankProfile ?? '',
    contextWindow: p.contextWindow != null ? String(p.contextWindow) : '',
    temperature: p.temperature != null ? String(p.temperature) : '',
    maxTokens: p.maxTokens != null ? String(p.maxTokens) : '',
    timeoutSec: p.timeoutMs != null ? String(Math.round(p.timeoutMs / 1000)) : '',
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
    editModel: '',
    applyModel: '',
    completionModel: '',
    agentModel: '',
    embeddingsModel: '',
    rerankModel: '',
    editProfile: '',
    applyProfile: '',
    completionProfile: '',
    agentProfile: '',
    embeddingsProfile: '',
    rerankProfile: '',
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
  if (opt(d.editModel)) profile.editModel = opt(d.editModel);
  if (opt(d.applyModel)) profile.applyModel = opt(d.applyModel);
  if (opt(d.completionModel)) profile.completionModel = opt(d.completionModel);
  if (opt(d.agentModel)) profile.agentModel = opt(d.agentModel);
  if (opt(d.embeddingsModel)) profile.embeddingsModel = opt(d.embeddingsModel);
  if (opt(d.rerankModel)) profile.rerankModel = opt(d.rerankModel);
  if (opt(d.editProfile)) profile.editProfile = opt(d.editProfile);
  if (opt(d.applyProfile)) profile.applyProfile = opt(d.applyProfile);
  if (opt(d.completionProfile)) profile.completionProfile = opt(d.completionProfile);
  if (opt(d.agentProfile)) profile.agentProfile = opt(d.agentProfile);
  if (opt(d.embeddingsProfile)) profile.embeddingsProfile = opt(d.embeddingsProfile);
  if (opt(d.rerankProfile)) profile.rerankProfile = opt(d.rerankProfile);
  if (num(d.contextWindow) != null) profile.contextWindow = num(d.contextWindow);
  if (num(d.temperature) != null) profile.temperature = num(d.temperature);
  if (num(d.maxTokens) != null) profile.maxTokens = num(d.maxTokens);
  if (num(d.timeoutSec) != null) profile.timeoutMs = num(d.timeoutSec)! * 1000;
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

/** "Run this role on a different profile" dropdown — sits under a role's model Field. */
function RoleProfileSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <label className="settings-field settings-role-profile">
      <span className="settings-label">↳ run on profile</span>
      <select className="settings-input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">this profile</option>
        {options.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SettingsView({ data }: { data: SettingsData | null }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showRoles, setShowRoles] = useState(false);

  if (!data) return <div className="empty">Loading settings…</div>;

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  if (draft) {
    const preset = data.presets.find((p) => p.id === draft.preset);
    const keySaved = draft.original ? (data.keySaved[draft.original] ?? false) : false;
    const inherits = `inherits chat (${draft.model || 'not set'})`;
    const otherProfiles = data.profiles.map((p) => p.name).filter((n) => n !== draft.name);
    return (
      <div className="settings">
        <div className="settings-title">
          {draft.original ? `Edit profile — ${draft.original}` : 'New profile'}
        </div>

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
              set({ preset: next.id, baseUrl: wasDefault ? next.defaultBaseUrl : draft.baseUrl });
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
        <Field label="Base URL" value={draft.baseUrl} onChange={(baseUrl) => set({ baseUrl })} />

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
              onChange={(e) => set({ apiKey: e.target.value, clearKey: false })}
            />
            {keySaved && !draft.clearKey && (
              <button className="ghost danger" onClick={() => set({ apiKey: '', clearKey: true })}>
                Clear
              </button>
            )}
          </div>
        </label>

        <Field
          label="Chat model"
          value={draft.model}
          onChange={(model) => set({ model })}
          placeholder="e.g. llama3.1, gpt-4o"
        />

        <button className="ghost settings-roles-toggle" onClick={() => setShowRoles((v) => !v)}>
          {showRoles ? '▾' : '▸'} Model roles &amp; tuning
        </button>
        {showRoles && (
          <>
            <Field label="Edit model" value={draft.editModel} onChange={(editModel) => set({ editModel })} placeholder={inherits} />
            <RoleProfileSelect value={draft.editProfile} onChange={(editProfile) => set({ editProfile })} options={otherProfiles} />
            <Field label="Apply model" value={draft.applyModel} onChange={(applyModel) => set({ applyModel })} placeholder="fast-apply merge model" />
            <RoleProfileSelect value={draft.applyProfile} onChange={(applyProfile) => set({ applyProfile })} options={otherProfiles} />
            <Field label="Autocomplete model" value={draft.completionModel} onChange={(completionModel) => set({ completionModel })} placeholder={inherits} />
            <RoleProfileSelect value={draft.completionProfile} onChange={(completionProfile) => set({ completionProfile })} options={otherProfiles} />
            <Field label="Agent model" value={draft.agentModel} onChange={(agentModel) => set({ agentModel })} placeholder={inherits} />
            <RoleProfileSelect value={draft.agentProfile} onChange={(agentProfile) => set({ agentProfile })} options={otherProfiles} />
            <Field label="Embeddings model" value={draft.embeddingsModel} onChange={(embeddingsModel) => set({ embeddingsModel })} placeholder="for semantic search / RAG" />
            <RoleProfileSelect value={draft.embeddingsProfile} onChange={(embeddingsProfile) => set({ embeddingsProfile })} options={otherProfiles} />
            <Field label="Rerank model" value={draft.rerankModel} onChange={(rerankModel) => set({ rerankModel })} placeholder="inherits edit → chat model" />
            <RoleProfileSelect value={draft.rerankProfile} onChange={(rerankProfile) => set({ rerankProfile })} options={otherProfiles} />
            <Field label="Context window (tokens)" value={draft.contextWindow} onChange={(contextWindow) => set({ contextWindow })} placeholder="auto — provider default, else 32768" type="number" />
            <Field label="Temperature" value={draft.temperature} onChange={(temperature) => set({ temperature })} placeholder="provider default" type="number" />
            <Field label="Max output tokens" value={draft.maxTokens} onChange={(maxTokens) => set({ maxTokens })} placeholder="provider default" type="number" />
            <Field label="Request timeout (seconds)" value={draft.timeoutSec} onChange={(timeoutSec) => set({ timeoutSec })} placeholder="300 — raise for local/slow models on large prompts" type="number" />
          </>
        )}

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
              setDraft(null);
            }}
          >
            Save
          </button>
          <button className="ghost" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="settings">
      <div className="settings-title">Provider profiles</div>
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
                title="Make this the active profile"
                onClick={() => postToExtension({ type: 'settingsActivateProfile', name: p.name })}
              >
                Use
              </button>
            )}
            <button className="ghost" onClick={() => setDraft(toDraft(p))}>
              Edit
            </button>
            <button
              className="ghost danger"
              title="Delete profile"
              onClick={() => postToExtension({ type: 'settingsDeleteProfile', name: p.name })}
            >
              ✕
            </button>
          </div>
        </div>
      ))}
      <button
        className="ghost settings-add"
        onClick={() => setDraft(newDraft(data.presets.find((p) => p.id === 'ollama') ?? data.presets[0]!))}
      >
        + Add profile
      </button>
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
