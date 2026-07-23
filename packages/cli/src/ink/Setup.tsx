import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import { createProvider, providerPresets, type ProviderPreset, type ProviderProfileConfig } from '@heapcode/core';
import { ConfigStore } from '../config/store.js';
import { SecretsStore } from '../config/secrets.js';
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
}

function Banner(): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2}>
        <Text color="cyan" bold>
          Heap Code
        </Text>
      </Box>
      <Text dimColor>Model-agnostic AI coding agent — any OpenAI-compatible API, local or cloud.</Text>
      <Text dimColor>Your code never leaves this machine except to the model endpoint you choose below.</Text>
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
export function Setup({ onComplete }: SetupProps): React.ReactElement {
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
      const config = new ConfigStore();
      const secrets = new SecretsStore();
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
      <Banner />
      {error && (
        <Box marginBottom={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {step.kind === 'provider' && (
        <Box flexDirection="column">
          <Text bold>Which provider?</Text>
          <SelectInput
            items={providerPresets.map((p) => ({ key: p.id, label: `${p.label}${p.local ? ' (local)' : ''}`, value: p }))}
            initialIndex={providerPresets.findIndex((p) => p.id === 'ollama')}
            onSelect={(item) => setStep({ kind: 'name', preset: item.value })}
          />
        </Box>
      )}

      {step.kind === 'name' && (
        <TextInput label="Profile name" defaultValue={step.preset.id} onSubmit={(name) => setStep({ kind: 'baseUrl', preset: step.preset, name: name || step.preset.id })} />
      )}

      {step.kind === 'baseUrl' && (
        <TextInput
          label="Base URL"
          defaultValue={step.preset.defaultBaseUrl}
          onSubmit={(baseUrl) => {
            const url = baseUrl || step.preset.defaultBaseUrl;
            if (step.preset.requiresApiKey) setStep({ kind: 'apiKey', preset: step.preset, name: step.name, baseUrl: url });
            else setStep({ kind: 'fetchingModels', preset: step.preset, name: step.name, baseUrl: url });
          }}
        />
      )}

      {step.kind === 'apiKey' && (
        <TextInput
          label="API key"
          mask
          onSubmit={(apiKey) => setStep({ kind: 'fetchingModels', preset: step.preset, name: step.name, baseUrl: step.baseUrl, apiKey })}
        />
      )}

      {step.kind === 'fetchingModels' && (
        <Text dimColor>
          <Spinner type="dots" /> Fetching available models…
        </Text>
      )}

      {step.kind === 'model' && (
        <Box flexDirection="column">
          <Text bold>Which model?</Text>
          <SelectInput
            items={step.models.map((m) => ({ label: m, value: m }))}
            onSelect={(item) =>
              setStep({
                kind: 'saving',
                profile: { name: step.name, preset: step.preset.id, baseUrl: step.baseUrl, model: item.value },
                apiKey: step.apiKey,
              })
            }
          />
        </Box>
      )}

      {step.kind === 'manualModel' && (
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
      )}

      {step.kind === 'saving' && (
        <Text dimColor>
          <Spinner type="dots" /> Saving…
        </Text>
      )}

      {step.kind === 'done' && (
        <Text color="green">✓ Saved profile "{step.profile.name}" ({step.profile.model}) and set it active.</Text>
      )}
    </Box>
  );
}
