export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryAfter: string | null;

  constructor(label: string, response: Pick<Response, "status" | "headers">) {
    super(`${label} returned ${response.status}`);
    this.name = "ProviderHttpError";
    this.status = response.status;
    this.retryAfter = response.headers.get("retry-after");
  }
}

export function providerHttpError(label: string, response: Response) {
  return new ProviderHttpError(label, response);
}

export function fetchWithProviderTimeout(
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS
) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  return fetchImpl(input, { ...init, signal });
}
