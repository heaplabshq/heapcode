import { OpenAICompatibleProvider } from './openaiCompatible.js';
import type {
  ChatRequest,
  CompletionRequest,
  EmbeddingsRequest,
  EmbeddingsResponse,
  ModelInfo,
  ProviderConfig,
} from './types.js';

const DEFAULT_API_VERSION = '2024-06-01';

/**
 * Azure OpenAI quirks:
 * - baseUrl is the resource endpoint (https://<resource>.openai.azure.com)
 * - the model is a *deployment name* embedded in the URL path
 * - auth uses an `api-key` header instead of a Bearer token
 * - every request needs an `api-version` query parameter
 */
export class AzureOpenAIProvider extends OpenAICompatibleProvider {
  private readonly apiVersion: string;

  constructor(config: ProviderConfig & { apiVersion?: string }) {
    super(config);
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
  }

  protected override chatUrl(req: ChatRequest): string {
    return this.url(
      `/openai/deployments/${encodeURIComponent(req.model)}/chat/completions?api-version=${this.apiVersion}`,
    );
  }

  protected override completionsUrl(req: CompletionRequest): string {
    return this.url(
      `/openai/deployments/${encodeURIComponent(req.model)}/completions?api-version=${this.apiVersion}`,
    );
  }

  protected override headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.config.apiKey ? { 'api-key': this.config.apiKey } : {}),
      ...this.config.headers,
    };
  }

  override async embeddings(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    const url = this.url(
      `/openai/deployments/${encodeURIComponent(req.model)}/embeddings?api-version=${this.apiVersion}`,
    );
    const res = await this.fetchOrThrow(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ input: req.input }),
      signal: req.signal ?? null,
    });
    if (!res.ok) throw new Error(`Embeddings failed with status ${res.status}`);
    const json = (await res.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return { embeddings: data.map((d) => d.embedding ?? []) };
  }

  override async listModels(): Promise<ModelInfo[]> {
    // Azure lists *deployments* via the management plane, which needs separate
    // credentials. Users type the deployment name instead.
    return [];
  }
}
