export interface ProviderCapabilities {
  nativeToolCalls: boolean;
  fim: boolean;
  embeddings: boolean;
  vision: boolean;
  /** Context window in tokens, when reliably known for typical models. */
  maxContext?: number;
}

export type PresetId =
  | 'openai'
  | 'ollama'
  | 'azure-openai'
  | 'openrouter'
  | 'together'
  | 'groq'
  | 'nvidia-nim'
  | 'lmstudio'
  | 'vllm'
  | 'localai'
  | 'custom';

export interface ProviderPreset {
  id: PresetId;
  label: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  local: boolean;
  /**
   * Sensible defaults for the preset. Real support varies by model —
   * users can override per profile (`capabilities` on the profile).
   */
  capabilities: ProviderCapabilities;
}

const caps = (
  overrides: Partial<ProviderCapabilities> = {},
): ProviderCapabilities => ({
  nativeToolCalls: true,
  fim: false,
  embeddings: true,
  vision: false,
  ...overrides,
});

export const providerPresets: readonly ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    local: false,
    capabilities: caps({ vision: true, maxContext: 128_000 }),
  },
  {
    id: 'ollama',
    label: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
    local: true,
    capabilities: caps({ vision: true }),
  },
  {
    id: 'azure-openai',
    label: 'Azure OpenAI',
    defaultBaseUrl: 'https://<resource>.openai.azure.com',
    requiresApiKey: true,
    local: false,
    capabilities: caps({ vision: true, maxContext: 128_000 }),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    local: false,
    capabilities: caps({ vision: true }),
  },
  {
    id: 'together',
    label: 'Together AI',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    requiresApiKey: true,
    local: false,
    capabilities: caps(),
  },
  {
    id: 'groq',
    label: 'Groq',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
    local: false,
    capabilities: caps({ embeddings: false }),
  },
  {
    id: 'nvidia-nim',
    label: 'NVIDIA NIM',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    requiresApiKey: true,
    local: false,
    capabilities: caps({maxContext: 128_000}),
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    defaultBaseUrl: 'http://localhost:1234/v1',
    requiresApiKey: false,
    local: true,
    capabilities: caps(),
  },
  {
    id: 'vllm',
    label: 'vLLM',
    defaultBaseUrl: 'http://localhost:8000/v1',
    requiresApiKey: false,
    local: true,
    capabilities: caps(),
  },
  {
    id: 'localai',
    label: 'LocalAI',
    defaultBaseUrl: 'http://localhost:8080/v1',
    requiresApiKey: false,
    local: true,
    capabilities: caps(),
  },
  {
    id: 'custom',
    label: 'Custom OpenAI-compatible endpoint',
    defaultBaseUrl: 'http://localhost:8000/v1',
    requiresApiKey: false,
    local: false,
    capabilities: caps({ nativeToolCalls: false }),
  },
];

export function getPreset(id: PresetId): ProviderPreset {
  const preset = providerPresets.find((p) => p.id === id);
  return preset ?? providerPresets[providerPresets.length - 1]!; // fall back to custom
}
