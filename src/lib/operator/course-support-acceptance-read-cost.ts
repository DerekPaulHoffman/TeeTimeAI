export const ACCEPTANCE_READ_QUERY_CATEGORIES = Object.freeze([
  "CAMPAIGN_RECORD", "PARKED_SNAPSHOT", "CURRENT_CYCLE_HISTORY", "MEMBER_OBSERVATIONS",
  "LEGACY_TERMINAL_HISTORY", "READER_EVIDENCE", "CONTINUATION_EVIDENCE", "UNCLASSIFIED",
] as const);
export type AcceptanceReadQueryCategory = (typeof ACCEPTANCE_READ_QUERY_CATEGORIES)[number];
export type AcceptanceReadCost = {
  readonly version: 1;
  readonly queryCategory: AcceptanceReadQueryCategory;
  readonly component: "STRUCTURAL_ENVELOPE" | "SELECTED_SCALARS";
  readonly basis: "OBSERVED_CONSERVATIVE_LOWER_BOUND";
  readonly complete: false;
  readonly limitBytes: number;
  readonly cumulativeBeforeComponentBytes: number;
  readonly componentChargeBytes: number;
  readonly attemptedCumulativeBytes: number;
  readonly hydrationObservedBytes: number;
  readonly saturated: boolean;
};

const BYTE_FIELDS = Object.freeze([
  "limitBytes", "cumulativeBeforeComponentBytes", "componentChargeBytes",
  "attemptedCumulativeBytes", "hydrationObservedBytes",
] as const);
const COST_FIELDS = [...BYTE_FIELDS, "version", "queryCategory", "component", "basis", "complete", "saturated"];
const MAX_BYTES = BigInt(Number.MAX_SAFE_INTEGER);

function ownData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !("value" in descriptors[key]))) return null;
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

/** No identifiers, query values or partial acceptance are eligible for this snapshot. */
export function parseAcceptanceReadCost(value: unknown): AcceptanceReadCost | null {
  try {
    const data = ownData(value);
    if (!data || Object.keys(data).length !== COST_FIELDS.length || COST_FIELDS.some((field) => !(field in data)) ||
        data.version !== 1 || data.basis !== "OBSERVED_CONSERVATIVE_LOWER_BOUND" || data.complete !== false ||
        typeof data.queryCategory !== "string" ||
        !(ACCEPTANCE_READ_QUERY_CATEGORIES as readonly string[]).includes(data.queryCategory) ||
        !["STRUCTURAL_ENVELOPE", "SELECTED_SCALARS"].includes(data.component as string) ||
        typeof data.saturated !== "boolean" ||
        BYTE_FIELDS.some((field) => !Number.isSafeInteger(data[field]) || (data[field] as number) < 0)) return null;
    const before = BigInt(data.cumulativeBeforeComponentBytes as number);
    const charge = BigInt(data.componentChargeBytes as number);
    const attempted = BigInt(data.attemptedCumulativeBytes as number);
    const hydration = BigInt(data.hydrationObservedBytes as number);
    if (charge === 0n || before > attempted || charge > attempted || hydration < charge || hydration > attempted ||
        data.component === "STRUCTURAL_ENVELOPE" && hydration !== charge) return null;
    const cappedSum = before + charge > MAX_BYTES ? MAX_BYTES : before + charge;
    if (attempted !== cappedSum || BigInt(data.limitBytes as number) < MAX_BYTES && attempted <= BigInt(data.limitBytes as number)) return null;
    if (data.saturated) {
      if (!BYTE_FIELDS.some((field) => data[field] === Number.MAX_SAFE_INTEGER)) return null;
    } else {
      if (before + charge !== attempted || attempted <= BigInt(data.limitBytes as number)) return null;
    }
    return Object.freeze({ ...data }) as AcceptanceReadCost;
  } catch { return null; }
}

/** Capture only operands already observed at the failing byte predicate. */
export function createAcceptanceReadCost(input: {
  queryCategory: AcceptanceReadQueryCategory;
  component: AcceptanceReadCost["component"];
  limitBytes: bigint;
  cumulativeBeforeComponentBytes: bigint;
  componentChargeBytes: bigint;
  attemptedCumulativeBytes: bigint;
  hydrationObservedBytes: bigint;
}): AcceptanceReadCost | null {
  if (BYTE_FIELDS.some((field) => typeof input[field] !== "bigint" || input[field] < 0n) ||
      input.cumulativeBeforeComponentBytes + input.componentChargeBytes !== input.attemptedCumulativeBytes ||
      input.attemptedCumulativeBytes <= input.limitBytes || input.componentChargeBytes === 0n ||
      input.hydrationObservedBytes < input.componentChargeBytes || input.hydrationObservedBytes > input.attemptedCumulativeBytes ||
      input.component === "STRUCTURAL_ENVELOPE" && input.hydrationObservedBytes !== input.componentChargeBytes) return null;
  const bytes = Object.fromEntries(BYTE_FIELDS.map((field) => [field, Number(input[field] > MAX_BYTES ? MAX_BYTES : input[field])]));
  return parseAcceptanceReadCost({ ...bytes, version: 1, queryCategory: input.queryCategory, component: input.component,
    basis: "OBSERVED_CONSERVATIVE_LOWER_BOUND", complete: false, saturated: BYTE_FIELDS.some((field) => input[field] > MAX_BYTES) });
}

/** Fixed native selection shapes only; unknown/new shapes stay unclassified. */
export function classifyAcceptanceReadQuery(delegateName: string, method: string, args: unknown): AcceptanceReadQueryCategory {
  try {
    if (!["findMany", "findFirst", "findUnique"].includes(method)) return "UNCLASSIFIED";
    const query = ownData(args);
    const select = ownData(query?.select);
    const nested = (value: unknown) => ownData(ownData(value)?.select);
    if (delegateName === "localReaderAgent" || delegateName === "localReaderJob") return "READER_EVIDENCE";
    if (!select) return "UNCLASSIFIED";
    if (delegateName === "courseSupportIncident") {
      if (Object.keys(select).length === 3 && select.id === true && select.cycle === true && nested(select.batchIncidents)) {
        return "CURRENT_CYCLE_HISTORY";
      }
      const course = nested(select.course);
      if (select.attemptLedger === true && course?.bookingMetadata === true && nested(course.monitoringStatus)) return "PARKED_SNAPSHOT";
      if (select.confirmedAt === true && select.activeBatchId === true &&
          nested(course?.monitoringStatus)?.stateChangedAt === true && nested(select.monitoringEvents)) return "MEMBER_OBSERVATIONS";
    }
    if (delegateName === "courseSupportBatchIncident" && select.proofSnapshot === true &&
        select.verifiedIncidentUpdatedAt === true && nested(select.batch)?.summary === true) return "LEGACY_TERMINAL_HISTORY";
    if (delegateName === "automationRun" && select.id === true && select.audit === true) return "CAMPAIGN_RECORD";
    if (delegateName === "automationRun" && select.id === true && select.runtimeVersion === true && select.startedAt === true ||
        delegateName === "courseMonitoringEvent" && select.incidentId === true && select.courseId === true &&
        select.occurredAt === true && select.runtimeVersion === true && select.outcome === true && select.audit === true) {
      return "CONTINUATION_EVIDENCE";
    }
    return "UNCLASSIFIED";
  } catch { return "UNCLASSIFIED"; }
}
