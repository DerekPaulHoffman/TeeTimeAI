import { beforeEach, describe, expect, it, vi } from "vitest";

const globalMocks = vi.hoisted(() => ({
  latest: vi.fn(),
  incidents: vi.fn(),
  parkedCount: vi.fn(),
  terminalEntries: vi.fn(),
  checks: vi.fn(),
  deployments: vi.fn(),
  probes: vi.fn(),
  transaction: vi.fn(),
  transactionControl: vi.fn(),
  mutation: vi.fn(),
  runtime: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    automationRun: {
      findFirst: globalMocks.latest,
      findMany: globalMocks.deployments,
      create: globalMocks.mutation,
      updateMany: globalMocks.mutation,
    },
    courseSupportIncident: {
      findMany: globalMocks.incidents,
      count: globalMocks.parkedCount,
      updateMany: globalMocks.mutation,
    },
    courseSupportBatchIncident: {
      findMany: globalMocks.terminalEntries,
      updateMany: globalMocks.mutation,
    },
    courseMonitoringEvent: {
      findMany: globalMocks.checks,
      create: globalMocks.mutation,
    },
    courseProbe: { findMany: globalMocks.probes },
    $transaction: globalMocks.transaction,
    $executeRawUnsafe: globalMocks.mutation,
  },
}));
vi.mock("./runtime-version", () => ({
  getAutomationRuntimeVersion: globalMocks.runtime,
}));

import {
  createParkedCourseCampaignAudit,
  inspectLatestParkedCourseCampaign,
  loadCampaignMemberObservations,
  summarizeParkedCourseCampaignProgress,
  PARKED_COURSE_CAMPAIGN_PROMPT_VERSION,
  type ParkedCourseCampaignDatabase,
  type ParkedCourseCampaignMember,
} from "./course-support-campaign";

const CAPTURED_AT = new Date("2026-08-20T12:00:00.000Z");
const NOW = new Date("2026-08-20T14:00:00.000Z");
const ORIGINAL_RUNTIME = "a".repeat(40);
const CURRENT_RUNTIME = "b".repeat(40);
const CONFIRMED_AT = new Date("2026-08-20T12:01:00.000Z");
const TERMINAL_AT = new Date("2026-08-20T12:20:00.000Z");
const PROVIDER_OBSERVED_AT = new Date("2026-08-20T12:40:00.000Z");
const member: ParkedCourseCampaignMember = {
  courseId: "private-course",
  incidentId: "private-incident",
  cycle: 3,
  revision: 7,
  monitoringRevision: 11,
  monitoringFailureFingerprint: "SOURCE:MISSING",
  kind: "NEEDS_ADAPTER",
  providerFamilyKey: "SOURCE_MISSING",
  failureClass: "MISSING_SOURCE",
  failureFingerprint: "SOURCE:MISSING",
  providerSnapshotFingerprint: "c".repeat(64),
  attemptLedgerFingerprint: "d".repeat(64),
  playbookConclusion: "UNRESOLVED_EXHAUSTED",
  latestProbeAt: null,
  latestDiscoveryAt: null,
};
const audit = createParkedCourseCampaignAudit({
  expectedCount: 1,
  capturedAt: CAPTURED_AT,
  members: [member],
});
const storedRun = {
  id: "private-campaign",
  status: "RUNNING",
  completedAt: null,
  outcome: null,
  audit,
};

beforeEach(() => {
  vi.resetAllMocks();
  globalMocks.runtime.mockReturnValue(CURRENT_RUNTIME);
  globalMocks.mutation.mockImplementation(() => {
    throw new Error("Inspection must remain read-only.");
  });
  globalMocks.transactionControl.mockResolvedValue(0);
  globalMocks.transaction.mockImplementation(async (read: (database: unknown) => Promise<unknown>) =>
    read({
      automationRun: { findFirst: globalMocks.latest, findMany: globalMocks.deployments },
      courseSupportIncident: { findMany: globalMocks.incidents, count: globalMocks.parkedCount },
      courseSupportBatchIncident: { findMany: globalMocks.terminalEntries },
      courseMonitoringEvent: { findMany: globalMocks.checks },
      courseProbe: { findMany: globalMocks.probes },
      $executeRawUnsafe: globalMocks.transactionControl,
    }),
  );
});

describe("latest parked campaign transaction-bound inspection", () => {
  it.each(["inspect", "observations"] as const)("uses one default read-only snapshot for %s", async (mode) => {
    const fixture = inspectionDatabase();
    installGlobalReads(fixture.reads);

    if (mode === "inspect") await inspectLatestParkedCourseCampaign();
    else {
      const rows = await loadCampaignMemberObservations(audit, new Set(), storedRun.id);
      expect(rows[0]?.latestProbe).toEqual(probeObservationValue(resolvedObservationRow().course.probes[0]!));
    }

    expect(globalMocks.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000,
    });
    expect(globalMocks.transactionControl.mock.calls).toEqual([
      ["SET TRANSACTION READ ONLY"], ["SET LOCAL statement_timeout = '25000ms'"],
    ]);
    expect(globalMocks.mutation).not.toHaveBeenCalled();
    expect(fixture.mutation).not.toHaveBeenCalled();
  });

  it.each([
    ["inspect", 0], ["inspect", 1], ["observations", 0], ["observations", 1],
  ] as const)("stops %s before reads when readonly setup command %i fails", async (mode, index) => {
    if (index === 1) globalMocks.transactionControl.mockResolvedValueOnce(0);
    globalMocks.transactionControl.mockRejectedValueOnce(new Error("Readonly snapshot setup failed."));

    await expect(mode === "inspect" ? inspectLatestParkedCourseCampaign()
      : loadCampaignMemberObservations(audit, new Set(), storedRun.id)).rejects.toThrow("Readonly snapshot setup failed.");

    expect(globalMocks.transaction).toHaveBeenCalledTimes(1);
    expect(globalMocks.transactionControl).toHaveBeenCalledTimes(index + 1);
    for (const key of ["latest", "incidents", "parkedCount", "probes", "checks", "deployments", "terminalEntries", "mutation"] as const) {
      expect(globalMocks[key]).not.toHaveBeenCalled();
    }
  });

  it("returns null through the supplied client without extra reads when no campaign exists", async () => {
    const { database, reads, mutation } = inspectionDatabase();
    reads.latest.mockResolvedValue(null);

    expect(await inspectLatestParkedCourseCampaign(database)).toBeNull();

    expect(reads.latest).toHaveBeenCalledExactlyOnceWith({
      where: { promptVersion: PARKED_COURSE_CAMPAIGN_PROMPT_VERSION },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        completedAt: true,
        outcome: true,
        audit: true,
      },
    });
    expect(reads.incidents).not.toHaveBeenCalled();
    expect(reads.parkedCount).not.toHaveBeenCalled();
    expectNoGlobalReadsOrWrites(mutation);
  });

  it("retains native defaults and the complete read pipeline without completing a terminal campaign", async () => {
    const baseline = inspectionDatabase();
    globalMocks.latest.mockImplementation(baseline.reads.latest);
    globalMocks.incidents.mockImplementation(baseline.reads.incidents);
    globalMocks.parkedCount.mockImplementation(baseline.reads.parkedCount);
    globalMocks.terminalEntries.mockImplementation(baseline.reads.terminalEntries);
    globalMocks.checks.mockImplementation(baseline.reads.checks);
    globalMocks.deployments.mockImplementation(baseline.reads.deployments);
    globalMocks.probes.mockImplementation(baseline.reads.probes);
    const expected = await inspectLatestParkedCourseCampaign();
    expect(expected).toMatchObject({
      status: "RUNNING",
      totalCount: 1,
      terminalCount: 1,
      monitoredCount: 1,
      automaticWithin24HoursCount: 1,
      remainingGlobalParkedCount: 0,
    });
    expect(globalMocks.transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000,
    });
    expect(globalMocks.transactionControl.mock.calls).toEqual([
      ["SET TRANSACTION READ ONLY"], ["SET LOCAL statement_timeout = '25000ms'"],
    ]);
    expect(globalMocks.transactionControl.mock.invocationCallOrder[1]).toBeLessThan(globalMocks.latest.mock.invocationCallOrder[0]!);
    const defaultQueries = baseline.reads.incidents.mock.calls.map(([query]) => query);
    vi.clearAllMocks();
    const { database, reads, mutation } = inspectionDatabase();

    const actual = await inspectLatestParkedCourseCampaign(database, {
      now: NOW,
      admissionRuntimeVersion: CURRENT_RUNTIME,
    });

    expect(actual).toEqual(expected);
    expect(reads.incidents.mock.calls.map(([query]) => query)).toEqual(defaultQueries);
    expect(reads.incidents).toHaveBeenCalledTimes(3);
    expect(reads.parkedCount).toHaveBeenCalledTimes(1);
    expect(reads.terminalEntries).toHaveBeenCalledTimes(1);
    expect(reads.checks).toHaveBeenCalledTimes(1);
    expect(reads.deployments).toHaveBeenCalledTimes(1);
    expect(reads.probes).toHaveBeenCalledTimes(1);
    expect(globalMocks.runtime).not.toHaveBeenCalled();
    expectNoGlobalReadsOrWrites(mutation);
  });

  it("reads local-reader freshness with the supplied clock and optional transaction models", async () => {
    const { database, reads, mutation } = inspectionDatabase();
    const parked = parkedReaderRow();
    reads.incidents.mockImplementation(async (query) => {
      if (query.where.status === "NEEDS_HUMAN") return [parked];
      if (typeof query.where.id === "string") {
        return [{ id: parked.id, cycle: parked.cycle, batchIncidents: [] }];
      }
      return [];
    });
    reads.parkedCount.mockResolvedValue(1);

    const result = await inspectLatestParkedCourseCampaign(database, {
      now: NOW,
      admissionRuntimeVersion: CURRENT_RUNTIME,
    });

    expect(result).toMatchObject({ status: "RUNNING", terminalCount: 0 });
    expect(reads.incidents).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "private-incident", cycle: 4 },
        take: 1,
      }),
    );
    expect(reads.searchCount).toHaveBeenCalledExactlyOnceWith({
      where: {
        status: "ACTIVE",
        preferences: { some: { courseId: "private-course" } },
      },
    });
    expect(reads.agents).toHaveBeenCalledExactlyOnceWith({
      where: {
        lastSeenAt: {
          gte: new Date("2026-08-20T13:55:00.000Z"),
          lte: NOW,
        },
      },
      orderBy: { deviceId: "asc" },
      take: 21,
      select: {
        deviceId: true,
        readerVersion: true,
        buildId: true,
        capabilities: true,
        lastSeenAt: true,
      },
    });
    expect(reads.jobs).not.toHaveBeenCalled();
    expect(globalMocks.runtime).not.toHaveBeenCalled();
    expectNoGlobalReadsOrWrites(mutation);
  });

  it("fails closed on an invalid stored audit before progress reads or any write", async () => {
    const { database, reads, mutation } = inspectionDatabase();
    reads.latest.mockResolvedValue({ ...storedRun, audit: { schemaVersion: 2 } });

    await expect(inspectLatestParkedCourseCampaign(database)).rejects.toThrow();

    expect(reads.incidents).not.toHaveBeenCalled();
    expect(reads.parkedCount).not.toHaveBeenCalled();
    expectNoGlobalReadsOrWrites(mutation);
  });
});

describe("exact native-selected campaign probe hydration", () => {
  it.each(["valid highest", "invalid highest", "newer invalid"] as const)(
    "preserves the latest timestamp and ID winner with %s and never falls back", async (kind) => {
      const fixture = probeObservationFixture();
      const base = fixture.rows[0]!.course.probes[0]!;
      const valid = { ...base, id: "private-probe-a" };
      const invalid = { ...base, id: "private-probe-z", rawSummary: null,
        observedAt: new Date(base.observedAt.getTime() + (kind === "newer invalid" ? 1 : 0)) };
      fixture.rows[0]!.course.probes = kind === "valid highest"
        ? [{ ...valid, id: "private-probe-z" }, { ...invalid, id: "private-probe-a" }]
        : [valid, invalid];

      const observations = await fixture.load();
      const chosen = kind === "valid highest" ? fixture.rows[0]!.course.probes[0]! : invalid;

      expect(observations[0]?.latestProbe).toEqual(probeObservationValue(chosen));
      expect(fixture.reads.probes.mock.calls[0]![0].where).toEqual({ id: { in: ["private-probe-z"] } });
      expect(fixture.reads.incidents.mock.calls[0]![0].select?.course).toMatchObject({ select: { probes: {
        where: { observedAt: { gte: CAPTURED_AT } },
        orderBy: [{ observedAt: "desc" }, { id: "desc" }], take: 1,
        select: { id: true, courseId: true, outcome: true, observedAt: true, runtimeVersion: true },
      } } });
      expect((fixture.reads.incidents.mock.calls[0]![0].select?.course as ObservationRelation).select.probes)
        .not.toHaveProperty("select.rawSummary");
      expect(summarizeParkedCourseCampaignProgress({ audit: fixture.audit, observations, remainingGlobalParkedCount: 0 }).monitoredCount)
        .toBe(kind === "valid highest" ? 1 : 0);
      expectNoGlobalReadsOrWrites(fixture.mutation);
    },
  );

  it.each([null, "malformed summary", ["malformed"], { providerExecution: "BOOKING_WINDOW_SKIP" },
    { providerExecution: "RUNNABLE_PROVIDER_CHECK", providerObservedAt: "invalid" }] as const)(
    "retains a complete null or malformed summary (%j) as native classifier input", async (rawSummary) => {
      const fixture = probeObservationFixture();
      Object.assign(fixture.rows[0]!.course.probes[0]!, { rawSummary });

      const observations = await fixture.load();

      expect(observations[0]?.latestProbe?.rawSummary).toEqual(rawSummary);
      expect(summarizeParkedCourseCampaignProgress({ audit: fixture.audit, observations, remainingGlobalParkedCount: 0 })).toMatchObject({
        monitoredCount: 0, terminalCount: 0, engineeringBlockerCount: 1,
      });
      expect(fixture.reads.probes).toHaveBeenCalledTimes(1);
      expectNoGlobalReadsOrWrites(fixture.mutation);
    },
  );

  it("loads the complete selected probe set for all 112 members without truncation or reordering", async () => {
    const fixture = probeObservationFixture(112);
    const nativeRead = fixture.reads.probes.getMockImplementation()!;
    fixture.reads.probes.mockImplementationOnce(async (query) => structuredClone(await nativeRead(query)).reverse());

    const observations = await fixture.load();

    expect(fixture.reads.probes).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: fixture.rows.map((row) => row.course.probes[0]!.id) } },
      select: { id: true, courseId: true, outcome: true, observedAt: true, runtimeVersion: true, rawSummary: true },
    });
    expect(observations).toHaveLength(112);
    expect(observations.map((row) => row.latestProbe)).toEqual(fixture.rows.map((row) => probeObservationValue(row.course.probes[0]!)));
    expect(observations.map((row) => row.incidentId)).toEqual(fixture.rows.map((row) => row.id));
    expect(new Set(observations.map((row) => row.incidentId))).toEqual(new Set(fixture.audit.members.map((row) => row.incidentId)));
    expect(summarizeParkedCourseCampaignProgress({ audit: fixture.audit, observations, remainingGlobalParkedCount: 0 })).toMatchObject({
      totalCount: 112, monitoredCount: 112, terminalCount: 112,
    });
    expectNoGlobalReadsOrWrites(fixture.mutation);
  });

  it("does not read probe payloads when no post-capture probe exists", async () => {
    const fixture = probeObservationFixture();
    fixture.rows[0]!.course.probes[0]!.observedAt = new Date(CAPTURED_AT.getTime() - 1);

    const observations = await fixture.load();

    expect(observations[0]?.latestProbe).toBeNull();
    expect(fixture.reads.probes).not.toHaveBeenCalled();
    expect(fixture.reads.checks).not.toHaveBeenCalled();
    expectNoGlobalReadsOrWrites(fixture.mutation);
  });

  it("retains a genuinely null runtime while refusing to count it as current-runtime monitoring", async () => {
    const fixture = probeObservationFixture();
    fixture.rows[0]!.course.probes[0]!.runtimeVersion = null;

    const observations = await fixture.load();

    expect(observations[0]?.latestProbe?.runtimeVersion).toBeNull();
    expect(summarizeParkedCourseCampaignProgress({ audit: fixture.audit, observations, remainingGlobalParkedCount: 0 }).monitoredCount).toBe(0);
    expect(fixture.reads.probes).toHaveBeenCalledTimes(1);
    expectNoGlobalReadsOrWrites(fixture.mutation);
  });

  it("fetches full summaries only for selected probes while excluding oversized historical scalars", async () => {
    const fixture = probeObservationFixture();
    const current = fixture.rows[0]!.course.probes[0]!;
    const oldSummaryRead = vi.fn(() => { throw new Error("Unused old summary was hydrated."); });
    const historical = Array.from({ length: 300 }, (_, index) => {
      const older = { ...current, id: `private-old-probe-${index}`, observedAt: new Date(current.observedAt.getTime() - (index + 1) * 1_000) };
      Object.defineProperty(older, "rawSummary", { enumerable: true, get: oldSummaryRead });
      return older;
    });
    fixture.rows[0]!.course.probes.push(...historical);

    const observations = await fixture.load();

    expect(oldSummaryRead).not.toHaveBeenCalled();
    expect(observations[0]?.latestProbe).toEqual(probeObservationValue(current));
    expect(fixture.reads.probes.mock.calls[0]![0].where).toEqual({ id: { in: [current.id] } });
    expectNoGlobalReadsOrWrites(fixture.mutation);
  });

  it.each([
    "missing", "duplicate", "extra", "unexpected ID", "wrong course", "changed outcome", "changed clock",
    "invalid clock", "null clock", "changed runtime", "missing summary", "undefined summary", "inherited summary",
  ] as const)("rejects %s complete probe bindings before later proof or continuation reads", async (kind) => {
    const fixture = probeObservationFixture();
    const nativeRead = fixture.reads.probes.getMockImplementation()!;
    fixture.reads.probes.mockImplementationOnce(async (query) => {
      const payloads = await nativeRead(query);
      const row = payloads[0]!;
      switch (kind) {
        case "missing": return [];
        case "duplicate": return [row, row];
        case "extra": return [row, { ...row, id: "private-extra-probe" }];
        case "unexpected ID": row.id = "private-foreign-probe"; break;
        case "wrong course": row.courseId = "private-foreign-course"; break;
        case "changed outcome": row.outcome = "FETCH_FAILED"; break;
        case "changed clock": row.observedAt = new Date((row.observedAt as Date).getTime() + 1); break;
        case "invalid clock": row.observedAt = new Date("invalid"); break;
        case "null clock": row.observedAt = null; break;
        case "changed runtime": row.runtimeVersion = ORIGINAL_RUNTIME; break;
        case "missing summary": delete row.rawSummary; break;
        case "undefined summary": row.rawSummary = undefined; break;
        case "inherited summary": {
          const rawSummary = row.rawSummary;
          delete row.rawSummary;
          Object.setPrototypeOf(row, { rawSummary });
          break;
        }
      }
      return payloads;
    });

    await expect(fixture.load()).rejects.toThrow(/^READ_FAILED$/);

    expect(fixture.reads.incidents).toHaveBeenCalledTimes(1);
    expect(fixture.reads.terminalEntries).not.toHaveBeenCalled();
    expect(fixture.reads.checks).not.toHaveBeenCalled();
    expect(fixture.reads.deployments).not.toHaveBeenCalled();
    expect(fixture.reads.jobs).not.toHaveBeenCalled();
    expect(fixture.reads.agents).not.toHaveBeenCalled();
    expectNoGlobalReadsOrWrites(fixture.mutation);
  });

  it.each(["blank ID", "missing ID", "wrong parent", "invalid clock", "null clock", "string clock", "duplicate ID"] as const)(
    "rejects selected probe metadata with %s before any complete payload read", async (kind) => {
      const fixture = probeObservationFixture(kind === "duplicate ID" ? 2 : 1);
      const nativeRead = fixture.reads.incidents.getMockImplementation()!;
      fixture.reads.incidents.mockImplementationOnce(async (query) => {
        const rows = await nativeRead(query);
        const probe = ((rows[0]!.course as Record<string, unknown>).probes as Record<string, unknown>[])[0]!;
        switch (kind) {
          case "blank ID": probe.id = "  "; break;
          case "missing ID": delete probe.id; break;
          case "wrong parent": probe.courseId = "private-wrong-course"; break;
          case "invalid clock": probe.observedAt = new Date("invalid"); break;
          case "null clock": probe.observedAt = null; break;
          case "string clock": probe.observedAt = PROVIDER_OBSERVED_AT.toISOString(); break;
          case "duplicate ID": ((rows[1]!.course as Record<string, unknown>).probes as Record<string, unknown>[])[0]!.id = probe.id; break;
        }
        return rows;
      });

      await expect(fixture.load()).rejects.toThrow(/^READ_FAILED$/);

      expect(fixture.reads.incidents).toHaveBeenCalledTimes(1);
      expect(fixture.reads.probes).not.toHaveBeenCalled();
      expect(fixture.reads.terminalEntries).not.toHaveBeenCalled();
      expect(fixture.reads.checks).not.toHaveBeenCalled();
      expect(fixture.reads.deployments).not.toHaveBeenCalled();
      expectNoGlobalReadsOrWrites(fixture.mutation);
    },
  );
});

type ObservationRelation = { select: ObservationSelect; where?: Record<string, unknown>; orderBy?: Record<string, string>[]; take?: number };
type ObservationSelect = { [key: string]: boolean | ObservationRelation };
type ObservationQuery = { where?: Record<string, unknown>; select: ObservationSelect };
type ProbeFixture = Record<string, unknown> & {
  id: string; courseId: string; outcome: string; observedAt: Date; runtimeVersion: string | null; rawSummary: unknown;
};

function probeObservationValue(probe: ProbeFixture) {
  const { outcome, observedAt, runtimeVersion, rawSummary } = probe;
  return { outcome, observedAt, runtimeVersion, rawSummary };
}

function projectObservationRow(row: Record<string, unknown>, select: ObservationSelect): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const [key, selection] of Object.entries(select)) {
    if (selection === true) projected[key] = row[key];
    else if (selection && typeof selection === "object") {
      const value = row[key];
      if (Array.isArray(value)) {
        const rows = (value as Record<string, unknown>[]).filter((child) => Object.entries(selection.where ?? {}).every(([field, filter]) =>
          filter && typeof filter === "object" && "gte" in filter
            ? child[field] instanceof Date && child[field].getTime() >= (filter.gte as Date).getTime()
            : true,
        )).sort((left, right) => {
          for (const order of selection.orderBy ?? []) for (const [field, direction] of Object.entries(order)) {
            const leftValue = left[field] instanceof Date ? left[field].getTime() : left[field];
            const rightValue = right[field] instanceof Date ? right[field].getTime() : right[field];
            if (leftValue !== rightValue) return ((leftValue as string | number) < (rightValue as string | number) ? -1 : 1) * (direction === "desc" ? -1 : 1);
          }
          return 0;
        });
        // The pinned Query strategy projects historical child scalars before
        // applying its per-parent take. Unselected rawSummary getters stay cold.
        projected[key] = rows.map((child) => projectObservationRow(child, selection.select)).slice(0, selection.take ?? rows.length);
      } else projected[key] = value === null ? null : projectObservationRow(value as Record<string, unknown>, selection.select);
    }
  }
  return projected;
}

function installGlobalReads(reads: ReturnType<typeof inspectionDatabase>["reads"]) {
  for (const key of ["latest", "incidents", "parkedCount", "terminalEntries", "checks", "deployments", "probes"] as const) {
    globalMocks[key].mockImplementation(reads[key]);
  }
}

function probeObservationFixture(count = 1) {
  const fixture = inspectionDatabase();
  const members = Array.from({ length: count }, (_, index) => ({ ...member,
    incidentId: `private-incident-${index}`, courseId: `private-course-${index}`,
  }));
  const selectedAudit = createParkedCourseCampaignAudit({ expectedCount: count, capturedAt: CAPTURED_AT, members });
  const rows = members.map((item, index) => {
    const row = resolvedObservationRow();
    row.id = item.incidentId;
    row.courseId = item.courseId;
    row.monitoringEvents[0]!.id = `private-terminal-${index}`;
    row.monitoringEvents[0]!.incidentId = item.incidentId;
    row.monitoringEvents[0]!.courseId = item.courseId;
    row.course.probes[0]!.id = `private-probe-${index}`;
    row.course.probes[0]!.courseId = item.courseId;
    return row;
  });
  fixture.reads.incidents.mockImplementation(async (query) => rows.map((row) => projectObservationRow(row, query.select)));
  fixture.reads.probes.mockImplementation(async (query) => rows.flatMap((row) => row.course.probes)
    .filter((probe) => (query.where?.id as { in: string[] }).in.includes(probe.id))
    .map((probe) => projectObservationRow(probe, query.select)));
  fixture.reads.checks.mockResolvedValue(rows.map((row) => ({ incidentId: row.id, courseId: row.courseId,
    occurredAt: PROVIDER_OBSERVED_AT, runtimeVersion: CURRENT_RUNTIME, outcome: "NO_MATCH", audit: null })));
  return { ...fixture, audit: selectedAudit, rows,
    load: () => loadCampaignMemberObservations(selectedAudit, new Set(), storedRun.id, fixture.database) };
}

function inspectionDatabase() {
  const resolved = resolvedObservationRow();
  const reads = {
    latest: vi.fn().mockResolvedValue(storedRun),
    incidents: vi.fn().mockImplementation(async (query) =>
      query.where.status === "NEEDS_HUMAN" ? [] : [projectObservationRow(resolved, query.select)],
    ),
    parkedCount: vi.fn().mockResolvedValue(0),
    terminalEntries: vi.fn().mockResolvedValue([]),
    checks: vi.fn().mockResolvedValue([
      {
        incidentId: member.incidentId,
        courseId: member.courseId,
        occurredAt: PROVIDER_OBSERVED_AT,
        runtimeVersion: CURRENT_RUNTIME,
        outcome: "NO_MATCH",
        audit: null,
      },
    ]),
    deployments: vi.fn().mockResolvedValue([
      {
        id: `cm_deploy_${CURRENT_RUNTIME}`,
        runtimeVersion: CURRENT_RUNTIME,
        startedAt: new Date("2026-08-20T12:30:00.000Z"),
      },
    ]),
    searchCount: vi.fn().mockResolvedValue(0),
    agents: vi.fn().mockResolvedValue([]),
    jobs: vi.fn().mockResolvedValue([]),
    probes: vi.fn(async (query: ObservationQuery) => resolved.course.probes
      .filter((probe) => (query.where?.id as { in: string[] }).in.includes(probe.id))
      .map((probe) => projectObservationRow(probe, query.select))),
  };
  const mutation = vi.fn(() => {
    throw new Error("Transaction-bound inspection must not mutate.");
  });
  const database = {
    automationRun: {
      findFirst: reads.latest,
      findMany: reads.deployments,
      create: mutation,
      updateMany: mutation,
    },
    courseSupportIncident: {
      findMany: reads.incidents,
      count: reads.parkedCount,
      updateMany: mutation,
    },
    courseSupportBatchIncident: {
      findMany: reads.terminalEntries,
      updateMany: mutation,
    },
    courseMonitoringEvent: { findMany: reads.checks, create: mutation },
    teeSearch: { count: reads.searchCount, updateMany: mutation },
    localReaderAgent: { findMany: reads.agents, updateMany: mutation },
    localReaderJob: { findMany: reads.jobs, create: mutation },
    courseProbe: { findMany: reads.probes, create: mutation },
    get $transaction() { throw new Error("A supplied snapshot must not be probed."); },
    get $executeRawUnsafe() { throw new Error("A supplied snapshot must not be reconfigured."); },
  } as unknown as ParkedCourseCampaignDatabase;
  return { database, reads, mutation };
}

function expectNoGlobalReadsOrWrites(mutation: ReturnType<typeof vi.fn>) {
  for (const key of [
    "latest", "incidents", "parkedCount", "terminalEntries", "checks", "deployments", "probes", "transaction", "transactionControl", "mutation",
  ] as const) expect(globalMocks[key]).not.toHaveBeenCalled();
  expect(mutation).not.toHaveBeenCalled();
}

function resolvedObservationRow() {
  return {
    id: member.incidentId,
    courseId: member.courseId,
    cycle: 4,
    status: "RESOLVED",
    activeBatchId: null,
    confirmedAt: CONFIRMED_AT,
    firstSeenAt: CONFIRMED_AT,
    providerFamilyKey: member.providerFamilyKey,
    failureClass: member.failureClass,
    attemptCount: 1,
    activeRealSearchCount: 0,
    attemptLedger: null,
    resolution: "MONITORING_RESTORED",
    resolvedAt: TERMINAL_AT,
    decisionAt: null,
    monitoringEvents: [{
      id: "private-terminal",
      incidentId: member.incidentId,
      courseId: member.courseId,
      eventType: "RECOVERED",
      source: "COURSE_SUPPORT_RESPONDER",
      fromState: "AUTO_INVESTIGATING",
      toState: "HEALTHY",
      occurredAt: TERMINAL_AT,
      outcome: "NO_MATCH",
      runtimeVersion: ORIGINAL_RUNTIME,
      deploymentSha: ORIGINAL_RUNTIME,
      audit: {
        cycle: 4,
        confirmedAt: CONFIRMED_AT.toISOString(),
        automatedFinal: true,
        freshRuntimeProof: true,
      },
    }],
    course: {
      monitoringStatus: { state: "HEALTHY", stateChangedAt: TERMINAL_AT },
      probes: [{
        id: "private-probe", courseId: member.courseId,
        outcome: "NO_MATCH",
        observedAt: new Date("2026-08-20T12:41:00.000Z"),
        runtimeVersion: CURRENT_RUNTIME,
        rawSummary: {
          providerExecution: "RUNNABLE_PROVIDER_CHECK",
          providerObservedAt: PROVIDER_OBSERVED_AT.toISOString(),
        },
      }] as ProbeFixture[],
    },
  };
}

function parkedReaderRow() {
  const parkedAt = new Date("2026-08-20T13:00:00.000Z");
  const stages = [
    ["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"],
    ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"],
    ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
    ["RENDERED_BROWSER_DISCOVERY", "RENDERED_BROWSER"],
    ["BROWSER_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"],
  ];
  return {
    id: member.incidentId,
    courseId: member.courseId,
    cycle: 4,
    revision: 9,
    kind: member.kind,
    providerFamilyKey: member.providerFamilyKey,
    failureClass: member.failureClass,
    failureFingerprint: member.failureFingerprint,
    attemptLedger: {
      version: 1,
      events: stages.map(([stage, readPath], index) => ({
        sequence: index + 1,
        cycle: 4,
        stage,
        transition: "NOT_APPLICABLE",
        readPath,
        evidenceKind: "TOOLING",
        observedAt: new Date(CAPTURED_AT.getTime() + index * 1_000).toISOString(),
        failureFingerprint: member.failureFingerprint,
        runtimeVersion: ORIGINAL_RUNTIME,
        skipReason: "NO_PROVIDER_METADATA",
      })),
    },
    humanReviewReason: "AUTOMATION_STALLED",
    status: "NEEDS_HUMAN",
    activeRealSearchCount: 0,
    escalatedAt: parkedAt,
    resolution: null,
    resolvedAt: null,
    resolutionMessage: null,
    resolutionNotifiedAt: null,
    decisionActorId: null,
    decisionAt: null,
    decisionNote: null,
    decisionEvidenceUrl: null,
    decisionIdempotencyKey: null,
    monitoringEvents: [{
      id: "private-parked",
      incidentId: member.incidentId,
      eventType: "HUMAN_REVIEW_REQUESTED",
      source: "RECOVERY_CRON",
      failureFingerprint: member.failureFingerprint,
      readPath: "LOCAL_READER",
      occurredAt: parkedAt,
      audit: {
        cycle: 4,
        customerState: "NEEDS_HUMAN_REVIEW",
        automationStalled: true,
        parkedUntilMaterialChange: true,
        playbookExhausted: false,
      },
    }],
    batchIncidents: [],
    course: {
      name: "Private Course",
      timeZone: "America/New_York",
      isPublic: true,
      website: "https://private.cps.golf/",
      detectedBookingUrl: "https://private.cps.golf/onlineresweb/search-teetime",
      detectedPlatform: "UNKNOWN",
      providerFamilyKey: "CPS",
      bookingMethod: "PUBLIC_ONLINE",
      automationEligibility: "ALLOWED",
      automationReason: "NONE",
      monitoringMode: "STANDARD",
      bookingAccessMode: "PUBLIC_SIGNED_OUT",
      bookingMetadata: null,
      preferences: [],
      monitoringStatus: {
        state: "ENGINEERING_VERIFICATION_NEEDED",
        revision: 13,
        failureFingerprint: member.failureFingerprint,
        nextAutomaticAttemptAt: null,
        revalidationRequestedAt: null,
      },
      probes: [],
      automationDiscoveries: [],
    },
  };
}
