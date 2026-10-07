/** Bounded, non-sensitive diagnostics for an owned simulator-support command. */
export type SimulatorSupportFailureStage = "INITIAL_OWNERSHIP" | "TARGET_SELECTION" | "PUBLIC_READ" | "POST_READ_OWNERSHIP" | "COMMAND";
export type SimulatorSupportFailureCategory = "OWNERSHIP" | "SOURCE" | "ACCESS" | "BUDGET" | "CAPACITY" | "NETWORK" | "BROWSER" | "DATABASE" | "TOOLING" | "UNKNOWN";
export type SimulatorSupportFailure = {
  stage: SimulatorSupportFailureStage;
  category: SimulatorSupportFailureCategory;
  code: string;
  sourceLocation?: string;
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
  "src/lib/automation/simulator-support-policy.ts",
  "src/lib/automation/simulator-support-progress.ts",
  "src/lib/automation/course-support-batches.ts",
  "src/lib/automation/course-support-course-dispatch.ts",
]);

function knownValue(record: Record<string, Classification>, key: string | undefined): Classification | undefined {
  return key && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Accept only a classifier-produced value before echoing a durable failure receipt. */
export function readSafeSimulatorSupportFailure(value: unknown): SimulatorSupportFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const record = value as Record<string, unknown>;
    if (!stages.has(record.stage as SimulatorSupportFailureStage) || !categories.has(record.category as SimulatorSupportFailureCategory) ||
        typeof record.code !== "string" || codeCategories.get(record.code) !== record.category) return null;
    if (record.code === "RESEARCH_RESERVATION_INTERRUPTED" && record.stage !== "PUBLIC_READ") return null;
    const sourceLocation = record.sourceLocation;
    if (sourceLocation !== undefined && (typeof sourceLocation !== "string" || sourceLocation.length > 240 ||
        !/^(?:src\/(?:lib|app)|scripts\/automation)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mjs|js):[1-9][0-9]*$/u.test(sourceLocation) ||
        !sourceModules.has(sourceLocation.replace(/:[1-9][0-9]*$/u, "")))) return null;
    return { stage: record.stage as SimulatorSupportFailureStage, category: record.category as SimulatorSupportFailureCategory,
      code: record.code, ...(sourceLocation ? { sourceLocation } : {}) };
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
    if (known) return { stage: stage === "COMMAND" ? known.stage ?? stage : stage, category: known.category, code: known.code, ...(sourceLocation ? { sourceLocation } : {}) };
  }
  return { stage, category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE", ...(sourceLocation ? { sourceLocation } : {}) };
}
