import type { SimulatorSupportClaim } from "./simulator-support-policy";

export const SIMULATOR_IMPLEMENTATION_BUSY = "Another course-support worker owns implementation authority.";
type Owner = { assignmentRef: string; ownerThreadId: string; token: string; revision: number; path: string };
type Claim = Pick<SimulatorSupportClaim, "token" | "revision" | "phase" | "leaseExpiresAt"> & { assignmentRef: string };
type Result<T> = { acquired: false } | { acquired: true; value: T };

/** Wait only after the exact transaction refusal raised before saveClaim.
 * Each attempt validates the same owner/source again; no provider read runs. */
export async function waitForSimulatorSupportPath<T extends Claim>(input: Owner, dependencies: {
  claim: (owner: Owner) => Promise<Result<T>>;
  heartbeat: (owner: Owner) => Promise<Result<T>>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  maximumWaitMs?: number;
}): Promise<Result<T & { deferredBusy?: true; outcome?: "implementation_deferred_busy" }>> {
  const maximum = dependencies.maximumWaitMs ?? 20 * 60_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 20 * 60_000) throw new Error("INVALID_IMPLEMENTATION_WAIT_BUDGET");
  const now = dependencies.now ?? (() => performance.now());
  const sleep = dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const deadline = now() + maximum;
  let owner = { ...input };
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
    if (remaining <= 0) return { acquired: true, value: { ...renewed.value,
      deferredBusy: true, outcome: "implementation_deferred_busy" } };
    await sleep(Math.min(15_000, remaining));
    // At the deadline report the latest actual heartbeat, not another claim.
    if (now() >= deadline) return { acquired: true, value: { ...renewed.value,
      deferredBusy: true, outcome: "implementation_deferred_busy" } };
  }
}
