import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { createProvider, providerPresets, type ProviderPreset, type ProviderProfileConfig } from '@heapcode/core';
import { ConfigStore, SecretsStore } from '@heapcode/host';
import { FilterableList } from './FilterableList.js';
import { TextInput } from './TextInput.js';

type Step =
  | { kind: 'provider' }
  | { kind: 'name'; preset: ProviderPreset }
  | { kind: 'baseUrl'; preset: ProviderPreset; name: string }
  | { kind: 'apiKey'; preset: ProviderPreset; name: string; baseUrl: string }
  | { kind: 'fetchingModels'; preset: ProviderPreset; name: string; baseUrl: string; apiKey?: string }
  | { kind: 'model'; preset: ProviderPreset; name: string; baseUrl: string; apiKey?: string; models: string[] }
  | { kind: 'manualModel'; preset: ProviderPreset; name: string; baseUrl: string; apiKey?: string }
  | { kind: 'saving'; profile: ProviderProfileConfig; apiKey?: string }
  | { kind: 'done'; profile: ProviderProfileConfig };

export interface SetupProps {
  /** Called once the profile is saved and active — the caller decides what happens next
   * (drop into the chat session, or just exit, depending on how Setup was invoked). */
  onComplete(profile: ProviderProfileConfig): void;
  /** Hide the product banner when embedded inside an existing session (/profile add). */
  banner?: boolean;
  /** Injected by the in-session flow so its ConfigStore cache sees the new
   * profile — each ConfigStore instance caches the file independently. */
  configStore?: ConfigStore;
  secretsStore?: SecretsStore;
}

function Banner(): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} alignSelf="flex-start">
        <Text color="cyan" bold>
          ◆ Welcome to heapcode
        </Text>
      </Box>
      <Text dimColor>Model-agnostic AI coding agent — any OpenAI-compatible API, local or cloud.</Text>
      <Text dimColor>Your code never leaves this machine except to the model endpoint you choose below.</Text>
      <Box marginTop={1}>
        <Text>Let’s connect your first model provider — this takes under a minute.</Text>
      </Box>
    </Box>
  );
}

/** Which of the wizard's four user-facing steps a state belongs to (apiKey shares the endpoint step). */
function stepNumber(kind: Step['kind']): number | undefined {
  switch (kind) {
    case 'provider':
      return 1;
    case 'name':
      return 2;
    case 'baseUrl':
    case 'apiKey':
      return 3;
    case 'model':
    case 'manualModel':
      return 4;
    default:
      return undefined;
  }
}

/**
 * A fetched model list can run into the hundreds (OpenRouter, for one) —
 * dumping all of them into a plain arrow-key list makes finding one
 * miserable. FilterableList narrows it as you type, and "Enter model name
 * manually" sits below the matches so a model that isn't in the list (or was
 * filtered out) is never a dead end — this is the *only* escape hatch when
 * the provider's /models endpoint doesn't happen to list something the user
 * knows exists.
 */
function ModelSelect({ models, onSelect, onManual }: { models: string[]; onSelect(model: string): void; onManual(): void }): React.ReactElement {
  return (
    <FilterableList
      items={models.map((m) => ({ label: m, value: m }))}
      onSelect={onSelect}
      footer={{ label: 'Enter model name manually…', onSelect: onManual }}
    />
  );
}

function StepLabel({ step, title }: { step: Step['kind']; title: string }): React.ReactElement {
  const n = stepNumber(step);
  return (
    <Box>
      {n !== undefined && <Text dimColor>Step {n}/4 · </Text>}
      <Text bold>{title}</Text>
    </Box>
  );
}

/**
 * Interactive onboarding: pick a provider, name the profile, confirm the
 * endpoint, enter an API key if needed, pick a model — all via arrow-key
 * select lists and inline text inputs inside the same Ink tree as the rest
 * of the app, rather than a separate plain-readline wizard. Used both for
 * `heapcode profile add` and for the automatic first-run flow when no
 * profile is configured yet.
 */
export function Setup({ onComplete, banner = true, configStore, secretsStore }: SetupProps): React.ReactElement {
  const [step, setStep] = useState<Step>({ kind: 'provider' });
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (step.kind !== 'fetchingModels') return;
    let cancelled = false;
    (async () => {
      try {
        const probe: ProviderProfileConfig = { name: step.name, preset: step.preset.id, baseUrl: step.baseUrl, model: '' };
        const provider = createProvider(probe, step.apiKey);
        const models = await provider.listModels();
        if (cancelled) return;
        if (models.length > 0) {
          setStep({ kind: 'model', preset: step.preset, name: step.name, baseUrl: step.baseUrl, apiKey: step.apiKey, models: models.map((m) => m.id) });
        } else {
          setStep({ kind: 'manualModel', preset: step.preset, name: step.name, baseUrl: step.baseUrl, apiKey: step.apiKey });
        }
      } catch {
        // Endpoint unreachable right now, or doesn't support /models — fall through to manual entry.
        if (!cancelled) setStep({ kind: 'manualModel', preset: step.preset, name: step.name, baseUrl: step.baseUrl, apiKey: step.apiKey });
      }
    })();
    return () => {
      cancelled = true;
    };
    // step is a discriminated union narrowed by the guard above; re-running on every
    // step change (not just entry into 'fetchingModels') is the correct/only option
    // since the relevant fields live on step itself.
  }, [step]);

  useEffect(() => {
    if (step.kind !== 'saving') return;
    let cancelled = false;
    (async () => {
      const config = configStore ?? new ConfigStore();
      const secrets = secretsStore ?? new SecretsStore();
      await config.saveProfile(step.profile);
      if (step.apiKey) await secrets.setApiKey(step.profile.name, step.apiKey);
      if (!cancelled) setStep({ kind: 'done', profile: step.profile });
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  useEffect(() => {
    if (step.kind === 'done') onComplete(step.profile);
  }, [step]);

  return (
    <Box flexDirection="column">
      {banner && <Banner />}
      {error && (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {step.kind === 'provider' && (
        <Box flexDirection="column">
          <StepLabel step="provider" title="Which provider?" />
          <SelectInput
            items={providerPresets.map((p) => ({ key: p.id, label: `${p.label}${p.local ? ' (local)' : ''}`, value: p }))}
            initialIndex={providerPresets.findIndex((p) => p.id === 'ollama')}
            onSelect={(item) => setStep({ kind: 'name', preset: item.value })}
          />
        </Box>
      )}

      {step.kind === 'name' && (
        <Box flexDirection="column">
          <StepLabel step="name" title="Name this profile" />
          <TextInput label="Profile name" defaultValue={step.preset.id} onSubmit={(name) => setStep({ kind: 'baseUrl', preset: step.preset, name: name || step.preset.id })} />
        </Box>
      )}

      {step.kind === 'baseUrl' && (
        <Box flexDirection="column">
          <StepLabel step="baseUrl" title="Endpoint" />
          <TextInput
            label="Base URL"
            defaultValue={step.preset.defaultBaseUrl}
            onSubmit={(baseUrl) => {
              const url = baseUrl || step.preset.defaultBaseUrl;
              if (step.preset.requiresApiKey) setStep({ kind: 'apiKey', preset: step.preset, name: step.name, baseUrl: url });
              else setStep({ kind: 'fetchingModels', preset: step.preset, name: step.name, baseUrl: url });
            }}
          />
        </Box>
      )}

      {step.kind === 'apiKey' && (
        <Box flexDirection="column">
          <StepLabel step="apiKey" title="API key (stored locally, chmod 600)" />
          {step.preset.apiKeyUrl && <Text dimColor>Get one at {step.preset.apiKeyUrl}</Text>}
          <TextInput
            label="API key"
            mask
            onSubmit={(apiKey) => setStep({ kind: 'fetchingModels', preset: step.preset, name: step.name, baseUrl: step.baseUrl, apiKey })}
          />
        </Box>
      )}

      {step.kind === 'fetchingModels' && (
        <Text dimColor>
          <Spinner type="dots" /> Fetching available models…
        </Text>
      )}

      {step.kind === 'model' && (
        <Box flexDirection="column">
          <StepLabel step="model" title={`Which model? (${step.models.length} available)`} />
          <ModelSelect
            models={step.models}
            onSelect={(model) =>
              setStep({
                kind: 'saving',
                profile: { name: step.name, preset: step.preset.id, baseUrl: step.baseUrl, model },
                apiKey: step.apiKey,
              })
            }
            onManual={() => setStep({ kind: 'manualModel', preset: step.preset, name: step.name, baseUrl: step.baseUrl, apiKey: step.apiKey })}
          />
        </Box>
      )}

      {step.kind === 'manualModel' && (
        <Box flexDirection="column">
          <StepLabel step="manualModel" title="Which model?" />
          <TextInput
            label="Model id (e.g. llama3.1:8b, gpt-4o-mini)"
            onSubmit={(model) => {
            if (!model) {
              setError('A model id is required.');
              return;
            }
              setError(undefined);
              setStep({
                kind: 'saving',
                profile: { name: step.name, preset: step.preset.id, baseUrl: step.baseUrl, model },
                apiKey: step.apiKey,
              });
            }}
          />
        </Box>
      )}

      {step.kind === 'saving' && (
        <Text dimColor>
          <Spinner type="dots" /> Saving…
        </Text>
      )}

      {step.kind === 'done' && (
        <Box flexDirection="column">
          <Text color="green">
            ✓ Saved profile "{step.profile.name}" ({step.profile.model}) and set it active.
          </Text>
          {!step.profile.embeddingsModel && (
            <Text dimColor>
              Semantic search needs a separate embeddings model — most chat-only providers don't offer one. Add a
              provider that does (e.g. Ollama + nomic-embed-text) via "heapcode profile add", then set{' '}
              {step.profile.name}'s embeddingsProfile to that profile's name in ~/.heapcode/config.json.
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
