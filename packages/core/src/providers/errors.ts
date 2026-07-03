export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export async function describeHttpError(res: Response): Promise<ProviderError> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    // non-JSON error body
  }
  const suffix = detail ? ` — ${detail}` : '';
  switch (res.status) {
    case 401:
    case 403:
      return new ProviderError(`Authentication failed (${res.status}). Check your API key.${suffix}`, res.status);
    case 404:
      return new ProviderError(`Endpoint or model not found (404). Check the base URL and model name.${suffix}`, res.status);
    case 429:
      return new ProviderError(`Rate limited (429). Try again shortly.${suffix}`, res.status);
    default:
      return new ProviderError(`Request failed with status ${res.status}.${suffix}`, res.status);
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
