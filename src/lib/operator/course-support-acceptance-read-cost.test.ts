import { describe, expect, it, vi } from "vitest";
import { ACCEPTANCE_READ_QUERY_CATEGORIES, classifyAcceptanceReadQuery, createAcceptanceReadCost,
  parseAcceptanceReadCost } from "./course-support-acceptance-read-cost";

const operands = {
  queryCategory: "CURRENT_CYCLE_HISTORY" as const, component: "SELECTED_SCALARS" as const,
  limitBytes: 100n, cumulativeBeforeComponentBytes: 80n, componentChargeBytes: 30n,
  attemptedCumulativeBytes: 110n, hydrationObservedBytes: 50n,
};

describe("aggregate byte-fence cost snapshots", () => {
  it("preserves the existing predicate operands as an immutable incomplete lower bound", () => {
    const cost = createAcceptanceReadCost(operands);
    expect(cost).toEqual({ version: 1, queryCategory: "CURRENT_CYCLE_HISTORY", component: "SELECTED_SCALARS",
      basis: "OBSERVED_CONSERVATIVE_LOWER_BOUND", complete: false, limitBytes: 100,
      cumulativeBeforeComponentBytes: 80, componentChargeBytes: 30, attemptedCumulativeBytes: 110,
      hydrationObservedBytes: 50, saturated: false });
    expect(Object.isFrozen(cost)).toBe(true);
    const input = { ...cost!, queryCategory: "CURRENT_CYCLE_HISTORY" };
    const detached = parseAcceptanceReadCost(input);
    input.queryCategory = "private-course";
    expect(detached).toEqual(cost);
    expect(detached).not.toBe(input);
  });

  it.each([
    { attemptedCumulativeBytes: 100n, componentChargeBytes: 20n },
    { attemptedCumulativeBytes: 99n, componentChargeBytes: 19n },
    { attemptedCumulativeBytes: 111n },
    { hydrationObservedBytes: 29n },
    { hydrationObservedBytes: 111n },
    { componentChargeBytes: 0n },
    { limitBytes: -1n },
    { cumulativeBeforeComponentBytes: -1n },
  ])("rejects non-failing or inconsistent operands %#", (change) => {
    expect(createAcceptanceReadCost({ ...operands, ...change })).toBeNull();
  });

  it("records envelope totals before their cumulative commit", () => {
    const cost = createAcceptanceReadCost({ ...operands, component: "STRUCTURAL_ENVELOPE", hydrationObservedBytes: 30n });
    expect(cost).toMatchObject({ component: "STRUCTURAL_ENVELOPE", componentChargeBytes: 30,
      hydrationObservedBytes: 30, cumulativeBeforeComponentBytes: 80, attemptedCumulativeBytes: 110 });
    expect(createAcceptanceReadCost({ ...operands, component: "STRUCTURAL_ENVELOPE" })).toBeNull();
  });

  it("saturates oversized counters without turning them into precise complete sizes", () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 10n;
    const cost = createAcceptanceReadCost({ ...operands, componentChargeBytes: huge,
      attemptedCumulativeBytes: huge + 80n, hydrationObservedBytes: huge + 20n });
    expect(cost).toMatchObject({ componentChargeBytes: Number.MAX_SAFE_INTEGER,
      attemptedCumulativeBytes: Number.MAX_SAFE_INTEGER, hydrationObservedBytes: Number.MAX_SAFE_INTEGER,
      saturated: true, complete: false, basis: "OBSERVED_CONSERVATIVE_LOWER_BOUND" });
    expect(JSON.stringify(cost)).not.toContain(huge.toString());
    expect(parseAcceptanceReadCost({ ...createAcceptanceReadCost(operands), saturated: true })).toBeNull();
    expect(parseAcceptanceReadCost({ ...createAcceptanceReadCost(operands),
      attemptedCumulativeBytes: Number.MAX_SAFE_INTEGER, saturated: true })).toBeNull();
    expect(createAcceptanceReadCost({ ...operands, componentChargeBytes: huge,
      attemptedCumulativeBytes: huge + 81n, hydrationObservedBytes: huge + 20n })).toBeNull();
  });

  it.each([
    { queryCategory: "private-provider" }, { version: 2 }, { complete: true }, { basis: "FULL_REQUIRED_BYTES" },
    { component: "private-column" }, { componentChargeBytes: "30" }, { componentChargeBytes: 30.1 },
    { attemptedCumulativeBytes: Number.POSITIVE_INFINITY }, { limitBytes: Number.MAX_SAFE_INTEGER + 1 },
    { courseId: "private-course" }, { sql: "private-query" }, { [Symbol("private")]: 1 },
  ])("rejects private or invalid metadata %#", (change) => {
    expect(parseAcceptanceReadCost({ ...createAcceptanceReadCost(operands), ...change })).toBeNull();
  });

  it("never evaluates getters or exposes hostile errors", () => {
    const getter = vi.fn(() => { throw new Error("private-query"); });
    const cost = { ...createAcceptanceReadCost(operands), get queryCategory() { return getter(); } };
    expect(parseAcceptanceReadCost(cost)).toBeNull();
    expect(parseAcceptanceReadCost(new Proxy({}, { getPrototypeOf() { throw new Error("private-query"); } }))).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("immutable fixed native hydration categories", () => {
  it.each([
    ["automationRun", { id: true, audit: true }, "CAMPAIGN_RECORD"],
    ["courseSupportIncident", { id: true, cycle: true, batchIncidents: { select: { proofSnapshot: true } } }, "CURRENT_CYCLE_HISTORY"],
    ["courseSupportIncident", { attemptLedger: true, course: { select: { bookingMetadata: true,
      monitoringStatus: { select: { state: true } } } } }, "PARKED_SNAPSHOT"],
    ["courseSupportIncident", { confirmedAt: true, activeBatchId: true, monitoringEvents: { select: { audit: true } },
      course: { select: { monitoringStatus: { select: { stateChangedAt: true } } } } }, "MEMBER_OBSERVATIONS"],
    ["courseSupportBatchIncident", { proofSnapshot: true, verifiedIncidentUpdatedAt: true,
      batch: { select: { summary: true } } }, "LEGACY_TERMINAL_HISTORY"],
    ["localReaderAgent", { id: true }, "READER_EVIDENCE"],
    ["localReaderJob", { id: true }, "READER_EVIDENCE"],
    ["automationRun", { id: true, runtimeVersion: true, startedAt: true }, "CONTINUATION_EVIDENCE"],
    ["courseMonitoringEvent", { incidentId: true, courseId: true, occurredAt: true, runtimeVersion: true,
      outcome: true, audit: true }, "CONTINUATION_EVIDENCE"],
  ])("recognizes a fixed %s projection while ignoring private filters", (delegate, select, category) => {
    const whereGetter = vi.fn(() => { throw new Error("private-provider"); });
    expect(classifyAcceptanceReadQuery(delegate as string, "findMany", { select, where: { get id() { return whereGetter(); } } })).toBe(category);
    expect(whereGetter).not.toHaveBeenCalled();
    expect(ACCEPTANCE_READ_QUERY_CATEGORIES).toContain(category);
  });

  it("keeps new, ambiguous, malformed and accessor projections unclassified", () => {
    const getter = vi.fn(() => { throw new Error("private-provider"); });
    expect(classifyAcceptanceReadQuery("course", "findMany", { select: { id: true } })).toBe("UNCLASSIFIED");
    expect(classifyAcceptanceReadQuery("courseSupportIncident", "findMany", { select: {
      id: true, cycle: true, batchIncidents: { select: { id: true } }, newField: true } })).toBe("UNCLASSIFIED");
    expect(classifyAcceptanceReadQuery("automationRun", "count", { select: { id: true, audit: true } })).toBe("UNCLASSIFIED");
    expect(classifyAcceptanceReadQuery("automationRun", "findFirst", { get select() { return getter(); } })).toBe("UNCLASSIFIED");
    expect(getter).not.toHaveBeenCalled();
    expect(Object.isFrozen(ACCEPTANCE_READ_QUERY_CATEGORIES)).toBe(true);
  });
});
