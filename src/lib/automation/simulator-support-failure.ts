/** Bounded, non-sensitive diagnostics for an owned simulator-support command. */
export type SimulatorSupportFailureStage = "INITIAL_OWNERSHIP" | "TARGET_SELECTION" | "PUBLIC_READ" | "POST_READ_OWNERSHIP" | "COMMAND";
export type SimulatorSupportFailureCategory = "OWNERSHIP" | "SOURCE" | "ACCESS" | "BUDGET" | "CAPACITY" | "NETWORK" | "BROWSER" | "DATABASE" | "TOOLING" | "UNKNOWN";
export type SimulatorResearchFailurePhase = "HTTP_READ" | "BROWSER_LAUNCH" | "BROWSER_CONTEXT" | "BROWSER_ROUTE_SETUP" |
  "BROWSER_REQUEST" | "BROWSER_NAVIGATION" | "BROWSER_DOCUMENT";
export type SimulatorResearchResourceKind = "MAIN_DOCUMENT" | "SECONDARY_DOCUMENT" | "SECONDARY_SCRIPT" |
  "SECONDARY_STYLESHEET" | "XHR_OR_FETCH" | "OTHER";
export type SimulatorSupportFailure = {
  stage: SimulatorSupportFailureStage;
  category: SimulatorSupportFailureCategory;
  code: string;
  sourceLocation?: string;
  researchPhase?: SimulatorResearchFailurePhase;
  researchResourceKind?: SimulatorResearchResourceKind;
};

type Classification = Pick<SimulatorSupportFailure, "category" | "code"> & { stage?: SimulatorSupportFailureStage };

const researchCodes: Record<string, Classification> = {
  SIMULATOR_RESEARCH_UNSAFE_URL: { category: "ACCESS", code: "UNSAFE_PUBLIC_URL" },
  SIMULATOR_RESEARCH_DESTINATION_CHANGED: { category: "ACCESS", code: "PUBLIC_DESTINATION_CHANGED" },
  SIMULATOR_RESEARCH_PROVIDER_BUSY: { category: "CAPACITY", code: "PROVIDER_CAPACITY_BUSY" },
  SIMULATOR_RESEARCH_NETWORK_FAILED: { category: "NETWORK", code: "PUBLIC_NETWORK_FAILED" },
  SIMULATOR_RESEARCH_DEADLINE: { category: "NETWORK", code: "PUBLIC_READ_DEADLINE" },
  SIMULATOR_RESEARCH_BODY_LIMIT: { category: "BUDGET", code: "PUBLIC_BODY_LIMIT" },
  SIMULATOR_RESEARCH_REQUEST_LIMIT: { category: "BUDGET", code: "PUBLIC_REQUEST_LIMIT" },
  SIMULATOR_RESEARCH_REDIRECT_LIMIT: { category: "BUDGET", code: "PUBLIC_REDIRECT_LIMIT" },
  SIMULATOR_RESEARCH_HARD_FAILED: { category: "UNKNOWN", code: "PUBLIC_READ_HARD_FAILED" },
};

const ownedMessages: Record<string, Classification> = {
  "Simulator support owner, revision or lease is stale.": { category: "OWNERSHIP", code: "OWNER_REVISION_OR_LEASE_STALE" },
  "Simulator source demand changed; preserve ownership and stop.": { category: "SOURCE", code: "SOURCE_DEMAND_CHANGED" },
  "Simulator offering source changed; an explicit owner adoption is required.": { category: "SOURCE", code: "OFFERING_SOURCE_CHANGED" },
  "Simulator research navigation belongs to an older source; adopt the reviewed source before research.": { category: "SOURCE", code: "RESEARCH_SOURCE_CHANGED", stage: "TARGET_SELECTION" },
  "Simulator source changed during the public read.": { category: "SOURCE", code: "SOURCE_CHANGED_DURING_READ", stage: "POST_READ_OWNERSHIP" },
  "The original simulator source research reservation changed.": { category: "OWNERSHIP", code: "RESEARCH_RESERVATION_CHANGED", stage: "POST_READ_OWNERSHIP" },
  "Simulator source research is already in flight; inspect its original attempt before continuing.": { category: "OWNERSHIP", code: "RESEARCH_IN_FLIGHT", stage: "TARGET_SELECTION" },
  "The bounded simulator source research budget is exhausted.": { category: "BUDGET", code: "RESEARCH_READ_BUDGET_EXHAUSTED", stage: "TARGET_SELECTION" },
  "The bounded simulator booking destination budget is exhausted.": { category: "BUDGET", code: "BOOKING_DESTINATION_BUDGET_EXHAUSTED", stage: "TARGET_SELECTION" },
  "The bounded same-site research depth is exhausted.": { category: "BUDGET", code: "SAME_SITE_DEPTH_EXHAUSTED", stage: "TARGET_SELECTION" },
  "Use a different simulator source research route; the identical route was already attempted.": { category: "BUDGET", code: "RESEARCH_ROUTE_REPEATED", stage: "TARGET_SELECTION" },
  "An unchanged structural source failure needs a different research route or materially changed source.": { category: "SOURCE", code: "STRUCTURAL_ROUTE_UNCHANGED", stage: "TARGET_SELECTION" },
  "The selected owned simulator source or link is unavailable.": { category: "SOURCE", code: "OWNED_SOURCE_UNAVAILABLE", stage: "TARGET_SELECTION" },
  "The selected link is not a fresh same-site page or official booking handoff.": { category: "ACCESS", code: "SAVED_LINK_NOT_ELIGIBLE", stage: "TARGET_SELECTION" },
  "Finish or reconcile the original source research attempt before retry.": { category: "OWNERSHIP", code: "RESEARCH_RECONCILIATION_REQUIRED" },
  "Recover is reserved for the same native owner after its lease expires.": { category: "OWNERSHIP", code: "RECOVERY_NOT_DUE" },
  "The original simulator research request is still within its bounded interval.": { category: "OWNERSHIP", code: "RESEARCH_REQUEST_STILL_ACTIVE" },
};

const causeCodes: Record<string, Classification> = {
  ENOTFOUND: { category: "NETWORK", code: "DNS_NOT_FOUND", stage: "PUBLIC_READ" },
  EAI_AGAIN: { category: "NETWORK", code: "DNS_RETRYABLE", stage: "PUBLIC_READ" },
  ECONNRESET: { category: "NETWORK", code: "CONNECTION_RESET", stage: "PUBLIC_READ" },
  ECONNREFUSED: { category: "NETWORK", code: "CONNECTION_REFUSED", stage: "PUBLIC_READ" },
  ETIMEDOUT: { category: "NETWORK", code: "CONNECTION_TIMEOUT", stage: "PUBLIC_READ" },
  OFFICIAL_SITE_BODY_LIMIT: { category: "BUDGET", code: "PUBLIC_BODY_LIMIT", stage: "PUBLIC_READ" },
  P1001: { category: "DATABASE", code: "DATABASE_UNREACHABLE" },
  P1002: { category: "DATABASE", code: "DATABASE_TIMEOUT" },
  P2028: { category: "DATABASE", code: "DATABASE_TRANSACTION_FAILED" },
  ENOENT: { category: "TOOLING", code: "REQUIRED_FILE_MISSING" },
};

const browserCodes: Record<string, Classification> = {
  NAME_NOT_RESOLVED: { category: "NETWORK", code: "BROWSER_DNS_FAILURE", stage: "PUBLIC_READ" },
  TIMED_OUT: { category: "NETWORK", code: "BROWSER_NETWORK_TIMEOUT", stage: "PUBLIC_READ" },
  CONNECTION_RESET: { category: "NETWORK", code: "BROWSER_CONNECTION_RESET", stage: "PUBLIC_READ" },
  CONNECTION_REFUSED: { category: "NETWORK", code: "BROWSER_CONNECTION_REFUSED", stage: "PUBLIC_READ" },
  CONNECTION_CLOSED: { category: "NETWORK", code: "BROWSER_CONNECTION_CLOSED", stage: "PUBLIC_READ" },
  INTERNET_DISCONNECTED: { category: "NETWORK", code: "BROWSER_OFFLINE", stage: "PUBLIC_READ" },
  ABORTED: { category: "BROWSER", code: "BROWSER_NAVIGATION_ABORTED", stage: "PUBLIC_READ" },
  BLOCKED_BY_CLIENT: { category: "BROWSER", code: "BROWSER_NAVIGATION_BLOCKED", stage: "PUBLIC_READ" },
};

const stages = new Set<SimulatorSupportFailureStage>(["INITIAL_OWNERSHIP", "TARGET_SELECTION", "PUBLIC_READ", "POST_READ_OWNERSHIP", "COMMAND"]);
const categories = new Set<SimulatorSupportFailureCategory>(["OWNERSHIP", "SOURCE", "ACCESS", "BUDGET", "CAPACITY", "NETWORK", "BROWSER", "DATABASE", "TOOLING", "UNKNOWN"]);
const researchPhases = new Set<SimulatorResearchFailurePhase>(["HTTP_READ", "BROWSER_LAUNCH", "BROWSER_CONTEXT", "BROWSER_ROUTE_SETUP",
  "BROWSER_REQUEST", "BROWSER_NAVIGATION", "BROWSER_DOCUMENT"]);
const resourceKinds = new Set<SimulatorResearchResourceKind>(["MAIN_DOCUMENT", "SECONDARY_DOCUMENT", "SECONDARY_SCRIPT",
  "SECONDARY_STYLESHEET", "XHR_OR_FETCH", "OTHER"]);
const trustedResearchPhases = new WeakMap<object, { phase: SimulatorResearchFailurePhase; order: number }>();
const trustedResourceKinds = new WeakMap<object, SimulatorResearchResourceKind>();
let nextResearchPhaseOrder = 0;
const additionalCodes: Classification[] = [
  { category: "NETWORK", code: "PUBLIC_READ_TIMEOUT" }, { category: "NETWORK", code: "PUBLIC_READ_ABORTED" },
  { category: "DATABASE", code: "DATABASE_OPERATION_FAILED" }, { category: "TOOLING", code: "INVALID_TOOL_DATA" },
  { category: "NETWORK", code: "PUBLIC_FETCH_FAILED" }, { category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE" },
  { category: "UNKNOWN", code: "RESEARCH_RESERVATION_INTERRUPTED", stage: "PUBLIC_READ" },
];
const codeCategories = new Map([...Object.values(researchCodes), ...Object.values(ownedMessages), ...Object.values(causeCodes),
  ...Object.values(browserCodes), ...additionalCodes].map(value => [value.code, value.category] as const));
const sourceModules = new Set([
  "scripts/automation/simulator-support.ts",
  "src/lib/automation/simulator-support-ownership.ts",
  "src/lib/automation/simulator-support-research.ts",
  "src/lib/automation/simulator-support-research-policy.ts",
  "src/lib/automation/simulator-support-failure.ts",
  "src/lib/automation/address-pinned-public-fetch.ts",
  "src/lib/automation/provider-request-lease.ts",
  "src/lib/automation/simulator-support-policy.ts",
  "src/lib/automation/simulator-support-progress.ts",
  "src/lib/automation/course-support-batches.ts",
  "src/lib/automation/course-support-course-dispatch.ts",
]);

function knownValue(record: Record<string, Classification>, key: string | undefined): Classification | undefined {
  return key && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Preserve the first trusted collector seam without mutating browser errors. */
export function tagSimulatorResearchFailure(error: unknown, phase: SimulatorResearchFailurePhase): unknown {
  if (!researchPhases.has(phase)) throw new Error("INVALID_SIMULATOR_RESEARCH_PHASE");
  const tagged = error !== null && (typeof error === "object" || typeof error === "function")
    ? error as object : new Error("SIMULATOR_RESEARCH_UNCLASSIFIED_FAILURE");
  if (!trustedResearchPhases.has(tagged)) trustedResearchPhases.set(tagged, { phase, order: nextResearchPhaseOrder++ });
  return tagged;
}

/** A closed collector-only projection of the request that failed, never a URL. */
export function tagSimulatorResearchResourceKind(error: unknown, kind: SimulatorResearchResourceKind): unknown {
  if (!resourceKinds.has(kind)) throw new Error("INVALID_SIMULATOR_RESEARCH_RESOURCE_KIND");
  const tagged = error !== null && (typeof error === "object" || typeof error === "function")
    ? error as object : new Error("SIMULATOR_RESEARCH_UNCLASSIFIED_FAILURE");
  if (!trustedResourceKinds.has(tagged)) trustedResourceKinds.set(tagged, kind);
  return tagged;
}

function trustedResearchResourceKind(error: unknown): SimulatorResearchResourceKind | undefined {
  const seen = new Set<unknown>();
  for (let depth = 0, current = error; depth < 4 && current && !seen.has(current); depth++, current = causeProperty(current)) {
    seen.add(current);
    if (typeof current === "object" || typeof current === "function") {
      const kind = trustedResourceKinds.get(current);
      if (kind) return kind;
    }
  }
  return undefined;
}

function trustedResearchPhase(error: unknown): SimulatorResearchFailurePhase | undefined {
  const seen = new Set<unknown>();
  let current = error;
  let first: { phase: SimulatorResearchFailurePhase; order: number } | undefined;
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth++, current = causeProperty(current)) {
    seen.add(current);
    if (typeof current !== "object" && typeof current !== "function") continue;
    const tagged = trustedResearchPhases.get(current);
    if (tagged && (!first || tagged.order < first.order)) first = tagged;
  }
  return first?.phase;
}

/** Accept only a classifier-produced value before echoing a durable failure receipt. */
export function readSafeSimulatorSupportFailure(value: unknown): SimulatorSupportFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const record = value as Record<string, unknown>;
    if (!stages.has(record.stage as SimulatorSupportFailureStage) || !categories.has(record.category as SimulatorSupportFailureCategory) ||
        typeof record.code !== "string" || codeCategories.get(record.code) !== record.category) return null;
    if (record.code === "RESEARCH_RESERVATION_INTERRUPTED" && record.stage !== "PUBLIC_READ") return null;
    const researchPhase = record.researchPhase;
    if (researchPhase !== undefined && (record.stage !== "PUBLIC_READ" || !researchPhases.has(researchPhase as SimulatorResearchFailurePhase))) return null;
    const researchResourceKind = record.researchResourceKind;
    if (researchResourceKind !== undefined && (record.stage !== "PUBLIC_READ" || !resourceKinds.has(researchResourceKind as SimulatorResearchResourceKind))) return null;
    const sourceLocation = record.sourceLocation;
    if (sourceLocation !== undefined && (typeof sourceLocation !== "string" || sourceLocation.length > 240 ||
        !/^(?:src\/(?:lib|app)|scripts\/automation)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js):[1-9][0-9]*$/u.test(sourceLocation) ||
        !sourceModules.has(sourceLocation.replace(/:[1-9][0-9]*$/u, "")))) return null;
    return { stage: record.stage as SimulatorSupportFailureStage, category: record.category as SimulatorSupportFailureCategory,
      code: record.code, ...(sourceLocation ? { sourceLocation } : {}),
      ...(researchPhase ? { researchPhase: researchPhase as SimulatorResearchFailurePhase } : {}),
      ...(researchResourceKind ? { researchResourceKind: researchResourceKind as SimulatorResearchResourceKind } : {}) };
  } catch { return null; }
}

function stringProperty(value: unknown, key: string): string | undefined {
  try {
    if (!value || typeof value !== "object") return undefined;
    const result = (value as Record<string, unknown>)[key];
    return typeof result === "string" ? result : undefined;
  } catch { return undefined; }
}

function causeProperty(value: unknown): unknown {
  try { return value && typeof value === "object" ? (value as { cause?: unknown }).cause : undefined; }
  catch { return undefined; }
}

function projectSourceLocation(error: unknown): string | undefined {
  const stack = stringProperty(error, "stack");
  if (!stack) return undefined;
  for (const line of stack.split(/\r?\n/u).slice(1, 16)) {
    if (!/^\s*at\s/u.test(line)) continue;
    if (/https?:\/\//u.test(line)) continue;
    const match = /(?:^|[\\/])((?:src[\\/](?:lib|app)|scripts[\\/]automation)[\\/][A-Za-z0-9_./\\-]+\.(?:ts|tsx|mjs|js)):(\d+)(?::\d+)?/u.exec(line);
    if (!match) continue;
    const path = match[1].replace(/\\/gu, "/");
    if (!sourceModules.has(path)) continue;
    return `${path}:${match[2]}`;
  }
  return undefined;
}

/** Never emits raw messages, causes, URLs, identifiers, credentials or stack traces. */
export function classifySimulatorSupportFailure(error: unknown, stage: SimulatorSupportFailureStage = "COMMAND"): SimulatorSupportFailure {
  const sourceLocation = projectSourceLocation(error);
  const researchPhase = trustedResearchPhase(error);
  const researchResourceKind = trustedResearchResourceKind(error);
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth++, current = causeProperty(current)) {
    seen.add(current);
    const message = stringProperty(current, "message");
    const name = stringProperty(current, "name");
    const causeCode = stringProperty(current, "code");
    const browserCode = /^page\.goto: net::ERR_([A-Z_]+)\b/u.exec(message ?? "")?.[1];
    const research = knownValue(researchCodes, message);
    const known = (research && { ...research, stage: "PUBLIC_READ" as const }) || knownValue(ownedMessages, message) ||
      knownValue(browserCodes, browserCode) || knownValue(causeCodes, causeCode) ||
      (name === "TimeoutError" || name === "AbortError" ? { category: "NETWORK" as const, code: name === "TimeoutError" ? "PUBLIC_READ_TIMEOUT" : "PUBLIC_READ_ABORTED", stage: "PUBLIC_READ" as const } : undefined) ||
      (name === "PrismaClientKnownRequestError" || name === "PrismaClientInitializationError" ? { category: "DATABASE" as const, code: "DATABASE_OPERATION_FAILED" } : undefined) ||
      (name === "SyntaxError" ? { category: "TOOLING" as const, code: "INVALID_TOOL_DATA" } : undefined) ||
      (name === "TypeError" && /fetch failed/iu.test(message ?? "") ? { category: "NETWORK" as const, code: "PUBLIC_FETCH_FAILED", stage: "PUBLIC_READ" as const } : undefined);
    if (known) {
      const classifiedStage = stage === "COMMAND" ? known.stage ?? stage : stage;
      return { stage: classifiedStage, category: known.category, code: known.code, ...(sourceLocation ? { sourceLocation } : {}),
        ...(classifiedStage === "PUBLIC_READ" && researchPhase ? { researchPhase } : {}),
        ...(classifiedStage === "PUBLIC_READ" && researchResourceKind ? { researchResourceKind } : {}) };
    }
  }
  return { stage, category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", ...(sourceLocation ? { sourceLocation } : {}),
    ...(stage === "PUBLIC_READ" && researchPhase ? { researchPhase } : {}),
    ...(stage === "PUBLIC_READ" && researchResourceKind ? { researchResourceKind } : {}) };
}
