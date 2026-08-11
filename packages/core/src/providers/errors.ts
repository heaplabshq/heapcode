export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/**
 * Gateways (OpenRouter, and other routers built like it) answer with their own
 * generic message and bury the upstream provider's real one in
 * `metadata.raw` — a JSON string, itself usually `{"error":{"message":…}}`.
 * "Provider returned error" alone is unactionable; "missing field
 * `tool_call_id`" is the actual bug report. Always surface both.
 */
export interface ProviderErrorBody {
  message?: string;
  /** Present when the body stands in for an HTTP status the response didn't use. */
  code?: number;
  metadata?: { raw?: unknown; provider_name?: string };
}

export function describeErrorBody(error: ProviderErrorBody | undefined): string {
  if (!error) return '';
  const message = error.message ?? '';
  const provider = error.metadata?.provider_name;
  const raw = error.metadata?.raw;

  let upstream = typeof raw === 'string' ? raw.trim() : '';
  if (upstream) {
    try {
      const parsed = JSON.parse(upstream) as { error?: { message?: string } | string };
      const inner = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
      if (inner) upstream = inner;
    } catch {
      // raw wasn't JSON — show it as-is
    }
  }
  if (upstream === message) upstream = '';

  // The provider name is worth surfacing even when `raw` is empty, which is
  // exactly what a router sends when its upstream failed without a body:
  // OpenRouter answers a dead model's request with 404 `{"message":"Provider
  // returned error","metadata":{"raw":"","provider_name":"Nvidia"}}`. Dropping
  // the name (as this used to, by returning early on an empty `raw`) leaves
  // "Provider returned error" — which reads as a local misconfiguration when
  // it is really one upstream being down.
  const attributed = upstream && provider ? `${provider}: ${upstream}` : upstream || provider || '';
  if (!attributed) return message;
  return message ? `${message} (${attributed})` : attributed;
}

/** Whether a router told us which upstream it routed to — see describeErrorBody. */
function hasUpstreamAttribution(error: ProviderErrorBody | undefined): boolean {
  return Boolean(error?.metadata?.provider_name);
}

/**
 * An error the endpoint put in the body of a response it did NOT fail — see
 * throwIfBodyError in openaiCompatible.ts. A distinct type because it needs
 * its own retry pass: an HTTP-status error has already been through
 * fetchOrThrow's retries by the time it is thrown, and retrying it again
 * would multiply the attempts (3 × 3) instead of capping them.
 */
export class ProviderBodyError extends ProviderError {}

export async function describeHttpError(res: Response): Promise<ProviderError> {
  let error: ProviderErrorBody | undefined;
  try {
    ({ error } = (await res.json()) as { error?: ProviderErrorBody });
  } catch {
    // non-JSON error body
  }
  const detail = describeErrorBody(error);
  const suffix = detail ? ` — ${detail}` : '';
  switch (res.status) {
    case 401:
    case 403:
      return new ProviderError(`Authentication failed (${res.status}). Check your API key.${suffix}`, res.status);
    case 404:
      // A router that names the upstream it picked has already accepted the
      // base URL and resolved the model slug, so telling the user to check
      // those sends them after the two things that demonstrably worked. The
      // model is listed but nothing is serving it — switching models is the
      // fix, and only the caller-facing message can say so.
      return new ProviderError(
        hasUpstreamAttribution(error)
          ? `Model unavailable upstream (404). The provider this model routes to is not serving it — try a different model.${suffix}`
          : `Endpoint or model not found (404). Check the base URL and model name.${suffix}`,
        res.status,
      );
    case 429:
      return new ProviderError(`Rate limited (429). Try again shortly.${suffix}`, res.status);
    default:
      return new ProviderError(`Request failed with status ${res.status}.${suffix}`, res.status);
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
