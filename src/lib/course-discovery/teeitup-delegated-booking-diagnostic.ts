export const delegatedDiagnosticStages = ["CAPABILITY", "SOURCE", "ROOT_READ", "ROOT_FRESH", "ROOT_IDENTITY", "ROOT_LINK", "HOP_ONE_READ", "NATIVE_DOCUMENT_READ",
  "HOP_ONE_FRESH", "HOP_TWO_LINK", "HOP_TWO_READ", "ROOT_REFRESH", "FINAL_FRESH", "CHAIN_REGISTER", "PROVIDER_BIND"] as const;
export const delegatedDiagnosticGates = ["capabilityAvailable", "sourceValid", "deadlineCurrent", "rootReadReturned", "rootFresh", "rootUrlExact",
  "canonicalAddressValid", "rootRawVenue", "rootRenderedVenue", "rootRawAddress", "rootRenderedAddress", "rootLinkVerified", "hopNative",
  "hopRawBounded", "hopRawLinkPresent", "hopRenderedLinkPresent", "hopUnique", "firstReadReturned", "firstFresh", "secondLinkVerified",
  "secondReadReturned", "rootRefreshRequired", "rootRefreshReturned", "rootRefreshIdentityMatches", "rootRefreshLinkMatches", "finalFresh", "finalUrlMatches",
  "directoryValid", "directoryIdsUnique", "providerUniqueMatch", "hopSessionOpen", "hopNoAccess", "hopNoFatal", "hopStatus200", "hopCaptured",
  "hopUrlMatches", "hopCaptureFresh", "hopTimeOriginMatches", "hopRawClosed", "hopNativeTransport"] as const;
export type DelegatedDiagnosticGate = typeof delegatedDiagnosticGates[number];
export type TeeItUpDelegationDiagnostic = { stage: typeof delegatedDiagnosticStages[number]; gates: Record<DelegatedDiagnosticGate, boolean | null> };
const failures = new WeakMap<object, TeeItUpDelegationDiagnostic>();
export function createDelegationDiagnostic(stage: TeeItUpDelegationDiagnostic["stage"] = "CAPABILITY"): TeeItUpDelegationDiagnostic {
  return { stage, gates: Object.fromEntries(delegatedDiagnosticGates.map(key => [key, null])) as TeeItUpDelegationDiagnostic["gates"] };
}
/** Failure-only closed facts; these cannot mint, renew or restore any proof. */
export function rememberTeeItUpDelegationFailure(error: unknown, diagnostic: TeeItUpDelegationDiagnostic) {
  if (!error || typeof error !== "object") return;
  const prior = failures.get(error);
  const gates = { ...diagnostic.gates };
  if (prior) for (const key of delegatedDiagnosticGates) if (prior.gates[key] !== null) gates[key] = prior.gates[key];
  failures.set(error, { stage: prior && prior.stage !== "NATIVE_DOCUMENT_READ" ? prior.stage : diagnostic.stage, gates });
}
export function getTeeItUpDelegationDiagnostic(error: unknown) {
  const value = error && typeof error === "object" ? failures.get(error) : undefined;
  return value ? { stage: value.stage, gates: { ...value.gates } } : undefined;
}
