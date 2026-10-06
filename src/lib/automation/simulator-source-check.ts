import { createAddressPinnedPublicFetch } from "./search-monitoring-discovery";
import { runWithProviderRequestLease } from "./provider-request-lease";

export type SimulatorSourceCheck = {
  outcome: "READ_OK" | "READ_FAILED" | "SOURCE_MISSING" | "NOT_CHECKED";
  httpStatus?: number;
};

/** Check only the saved official landing. This is not proof of rental availability. */
export async function checkSimulatorOfficialSource(
  source: string | null,
  fetchImpl: typeof fetch = createAddressPinnedPublicFetch(),
): Promise<SimulatorSourceCheck> {
  if (!source) return { outcome: "SOURCE_MISSING" };
  try {
    const read = await runWithProviderRequestLease(new URL(source).hostname, () => fetchImpl(source, {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(10_000),
    }));
    if (!read.acquired) return { outcome: "NOT_CHECKED" };
    const response = read.value;
    return {
      outcome: response.ok ? "READ_OK" : "READ_FAILED",
      httpStatus: response.status,
    };
  } catch {
    return { outcome: "READ_FAILED" };
  }
}
