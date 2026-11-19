import type { SimulatorSupportClaim } from "./simulator-support-policy";

export const SIMULATOR_IMPLEMENTATION_BUSY = "Another course-support worker owns implementation authority.";
type Owner = { assignmentRef: string; ownerThreadId: string; token: string; revision: number; path: string };
type Claim = Pick<SimulatorSupportClaim, "token" | "revision" | "phase" | "leaseExpiresAt" | "pendingImplementation"> & { assignmentRef: string };
type Result<T> = { acquired: false } | { acquired: true; value: T };

/** Wait only after the exact transaction refusal raised before saveClaim.
 * Each attempt validates the same owner/source again; no provider read runs. */
export async function waitForSimulatorSupportPath<T extends Claim>(input: Owner, dependencies: {
  claim: (owner: Owner) => Promise<Result<T>>;
  heartbeat: (owner: Owner) => Promise<Result<T>>;
  defer: (owner: Owner) => Promise<Result<T>>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  maximumWaitMs?: number;
}): Promise<Result<T & { deferredBusy?: true; stopWorker?: true; outcome?: "implementation_deferred_busy" }>> {
  const maximum = dependencies.maximumWaitMs ?? 20 * 60_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 20 * 60_000) throw new Error("INVALID_IMPLEMENTATION_WAIT_BUDGET");
  const now = dependencies.now ?? (() => performance.now());
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = now() + maximum;
  let owner = { ...input };
  const defer = async () => {
    const result = await dependencies.defer(owner);
    if (!result.acquired) return result;
    if (result.value.assignmentRef !== owner.assignmentRef || result.value.token !== owner.token ||
        !Number.isSafeInteger(result.value.revision) || result.value.revision <= owner.revision ||
        result.value.phase !== "WAITING_IMPLEMENTATION" || result.value.pendingImplementation?.path !== owner.path)
      throw new Error("IMPLEMENTATION_WAIT_NOT_PERSISTED");
    return { acquired: true as const, value: { ...result.value,
      deferredBusy: true as const, stopWorker: true as const, outcome: "implementation_deferred_busy" as const } };
  };
  for (;;) {
    try {
      const result = await dependencies.claim(owner);
      if (result.acquired && (result.value.phase !== "IMPLEMENTING" || result.value.assignmentRef !== owner.assignmentRef ||
          result.value.token !== owner.token || !Number.isSafeInteger(result.value.revision) || result.value.revision <= owner.revision)) {
        throw new Error("IMPLEMENTATION_PATH_NOT_CONFIRMED");
      }
      return result;
    } catch (error) {
      // This exact error is raised only before the path/phase write. Unknown
      // errors, admitted ownership failures and uncertain effects never retry.
      if (!(error instanceof Error) || error.message !== SIMULATOR_IMPLEMENTATION_BUSY) throw error;
    }
    const renewed = await dependencies.heartbeat(owner);
    if (!renewed.acquired) return renewed;
    if (renewed.value.assignmentRef !== owner.assignmentRef || renewed.value.token !== owner.token ||
        !Number.isSafeInteger(renewed.value.revision) || renewed.value.revision <= owner.revision) {
      throw new Error("IMPLEMENTATION_WAIT_OWNERSHIP_UNCONFIRMED");
    }
    owner = { ...owner, revision: renewed.value.revision };
    const remaining = deadline - now();
    if (remaining <= 0) return defer();
    await sleep(Math.min(15_000, remaining));
    // Persist waiting intent at the deadline without another path claim.
    if (now() >= deadline) return defer();
  }
}
