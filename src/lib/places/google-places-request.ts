const GOOGLE_PLACES_MAX_ATTEMPTS = 2;
const GOOGLE_PLACES_DEFAULT_RETRY_DELAY_MS = 150;
const GOOGLE_PLACES_MAX_RETRY_DELAY_MS = 1_000;
const GOOGLE_PLACES_ATTEMPT_TIMEOUT_MS = 5_000;
const GOOGLE_PLACES_TOTAL_TIMEOUT_MS = 12_000;

type GooglePlacesRequestTiming = {
  attemptTimeoutMs?: number;
  totalTimeoutMs?: number;
};

type GooglePlacesRequestResult<T> = {
  response: Response;
  json?: T;
};

export async function fetchGooglePlacesWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  timing: GooglePlacesRequestTiming = {}
) {
  const result = await runGooglePlacesRequest(input, init, timing);
  return result.response;
}

export async function fetchGooglePlacesJsonWithRetry<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  timing: GooglePlacesRequestTiming = {}
): Promise<GooglePlacesRequestResult<T>> {
  return runGooglePlacesRequest<T>(input, init, timing, readJsonResponse);
}

async function runGooglePlacesRequest<T = never>(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timing: GooglePlacesRequestTiming,
  parseResponse?: (response: Response, signal: AbortSignal) => Promise<T>
): Promise<GooglePlacesRequestResult<T>> {
  const callerSignal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const attemptTimeoutMs = normalizeTimeoutMs(
    timing.attemptTimeoutMs,
    GOOGLE_PLACES_ATTEMPT_TIMEOUT_MS
  );
  const totalTimeout = createTimeoutSignal(
    normalizeTimeoutMs(timing.totalTimeoutMs, GOOGLE_PLACES_TOTAL_TIMEOUT_MS),
    "Google Places request exceeded its total deadline"
  );
  const operationSignal = composeSignals([callerSignal, totalTimeout.signal]);
  let lastError: unknown;

  try {
    throwIfAborted(operationSignal.signal);

    for (let attempt = 1; attempt <= GOOGLE_PLACES_MAX_ATTEMPTS; attempt += 1) {
      const attemptTimeout = createTimeoutSignal(
        attemptTimeoutMs,
        "Google Places request attempt timed out"
      );
      const requestSignal = composeSignals([
        operationSignal.signal,
        attemptTimeout.signal
      ]);
      let response: Response | undefined;
      let retryDelayMs: number | null = null;

      try {
        response = await waitForSignal(
          fetch(input, { ...init, signal: requestSignal.signal }),
          requestSignal.signal
        );
        if (
          isTransientGooglePlacesStatus(response.status) &&
          attempt < GOOGLE_PLACES_MAX_ATTEMPTS
        ) {
          retryDelayMs = getRetryDelayMs(response);
          if (retryDelayMs === null) {
            return { response };
          }
          await cancelTransientResponseBody(response, requestSignal.signal);
        } else {
          const json =
            parseResponse && response.ok
              ? await parseResponse(response, requestSignal.signal)
              : undefined;
          return { response, json };
        }
      } catch (error) {
        if (callerSignal?.aborted) {
          throw getAbortReason(callerSignal, "Google Places request was cancelled");
        }
        if (totalTimeout.signal.aborted) {
          throw getAbortReason(
            totalTimeout.signal,
            "Google Places request exceeded its total deadline"
          );
        }
        if (attemptTimeout.signal.aborted) {
          lastError = getAbortReason(
            attemptTimeout.signal,
            "Google Places request attempt timed out"
          );
        } else {
          lastError = error;
          if (isAbortError(error)) {
            throw error;
          }
        }

        if (attempt === GOOGLE_PLACES_MAX_ATTEMPTS) {
          throw lastError;
        }
        retryDelayMs = GOOGLE_PLACES_DEFAULT_RETRY_DELAY_MS;
      } finally {
        requestSignal.cleanup();
        attemptTimeout.cleanup();
      }

      await wait(
        retryDelayMs ?? GOOGLE_PLACES_DEFAULT_RETRY_DELAY_MS,
        operationSignal.signal
      );
    }
  } finally {
    operationSignal.cleanup();
    totalTimeout.cleanup();
  }

  throw lastError;
}

async function readJsonResponse<T>(response: Response, signal: AbortSignal) {
  if (!response.body || typeof response.body.getReader !== "function") {
    return waitForSignal(response.json() as Promise<T>, signal);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    while (true) {
      const { done, value } = await waitForSignal(reader.read(), signal);
      if (done) {
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled native stream may release its lock asynchronously.
    }
  }

  return JSON.parse(text) as T;
}

function isTransientGooglePlacesStatus(status: number) {
  return status === 429 || (status >= 500 && status <= 599);
}

function getRetryDelayMs(response: Response) {
  const retryAfter = response.headers?.get("Retry-After");
  if (!retryAfter) {
    return GOOGLE_PLACES_DEFAULT_RETRY_DELAY_MS;
  }

  const seconds = Number(retryAfter);
  const delayMs = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1_000)
    : Math.max(0, Date.parse(retryAfter) - Date.now());

  return Number.isFinite(delayMs) && delayMs <= GOOGLE_PLACES_MAX_RETRY_DELAY_MS
    ? delayMs
    : null;
}

function isAbortError(error: unknown) {
  return (
    (error instanceof Error || error instanceof DOMException) &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

async function cancelTransientResponseBody(
  response: Response,
  signal: AbortSignal
) {
  if (!response.body) {
    return;
  }

  try {
    await waitForSignal(response.body.cancel(), signal);
  } catch {
    if (signal.aborted) {
      throw getAbortReason(signal, "Google Places request was cancelled");
    }
    // The retry is still safe when a synthetic or already-locked body cannot
    // be cancelled. Native fetch responses release the connection on cancel.
  }
}

function createTimeoutSignal(timeoutMs: number, message: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException(message, "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout)
  };
}

function composeSignals(signals: Array<AbortSignal | null | undefined>) {
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];

  for (const signal of signals) {
    if (!signal) {
      continue;
    }
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    }
  };
}

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(getAbortReason(signal, "Google Places request was cancelled"));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(getAbortReason(signal, "Google Places request was cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function wait(delayMs: number, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(getAbortReason(signal, "Google Places request was cancelled"));
  }
  if (delayMs <= 0) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      cleanup();
      reject(getAbortReason(signal, "Google Places request was cancelled"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function getAbortReason(signal: AbortSignal, fallbackMessage: string) {
  const reason = signal.reason;
  return reason instanceof Error || reason instanceof DOMException
    ? reason
    : new DOMException(fallbackMessage, "AbortError");
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw getAbortReason(signal, "Google Places request was cancelled");
  }
}

function normalizeTimeoutMs(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && (value ?? 0) > 0
    ? Math.max(1, Math.floor(value as number))
    : fallback;
}
