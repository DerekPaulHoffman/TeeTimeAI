import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn(), upsert: vi.fn() });
  return { $transaction: vi.fn(), $queryRaw: vi.fn(), course: model(), localReaderJob: model(), localReaderAgent: model(),
    courseSupportIncident: model(), courseSupportBatch: model(), courseSupportBatchIncident: model(),
    courseAutomationDiscovery: model(), courseMonitoringStatus: model(), courseMonitoringEvent: model(),
    teeSearch: model(), teeTimeMatch: model(), automationRun: model() };
});
const marker = vi.hoisted(() => ({ beginCourseProviderObservationInTransaction: vi.fn(),
  renewCourseProviderObservationInTransaction: vi.fn(), releaseCourseProviderObservationInTransaction: vi.fn(),
  markCourseProviderObservationUnreconciledInTransaction: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/automation/provider-execution-marker", async original => ({
  ...await original<typeof import("@/lib/automation/provider-execution-marker")>(), ...marker,
}));
vi.mock("@/lib/automation/worker-state", () => ({ AUTOMATION_WORKERS: { LOCAL_READER: {} },
  startAutomationWorker: async () => ({ allowed: true }), completeAutomationWorker: vi.fn() }));
vi.mock("@/lib/env", async original => ({ ...await original<typeof import("@/lib/env")>(), hasDatabaseConfig: () => true }));

import { getOwnedOfficialSourceObservation } from "./official-source-jobs";
import { claimNextLocalReaderJob } from "./service";
import { discoverFromOfficialSource } from "./official-source-discovery";
import { signLocalReaderPayload } from "./contracts";
import { type OfficialSourcePage } from "./official-source-contracts";
import { POST } from "@/app/api/local-reader/jobs/[id]/result/route";
import { buildCourseSupportProviderSnapshotFingerprint } from "@/lib/automation/course-support-verification";
import { appendAutomationPlaybookEvent, assessAutomationPlaybook, AUTOMATION_PLAYBOOK_STAGES } from "@/lib/automation/course-monitoring-playbook";
import { revalidateForOfficialSourceReader, canRevalidateOfficialSource } from "./official-source-revalidation";
import { routeCourseSupportRemediation } from "@/lib/automation/course-support-remediation-routing";
import { inspectCourseSupportQueue } from "@/lib/automation/course-support-batches";
import { recordAndApplyOwnedBrowserDiscoveryToCourse } from "@/lib/automation/db-service";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";

type Row = Record<string, unknown>;
// State-bearing in-memory DB boundary: actual queue, authentication, lease,
// ownership, discovery and canonical projection code execute unchanged.
function matches(row: Row | null, where: Row): boolean {
  if (!row) return false;
  return Object.entries(where).every(([key, wanted]) => {
    if (key === "AND") return (wanted as Row[]).every(value => matches(row, value));
    if (key === "OR") return (wanted as Row[]).some(value => matches(row, value));
    if (key === "NOT") return !matches(row, wanted as Row);
    const value = row[key];
    if (wanted && typeof wanted === "object" && !(wanted instanceof Date)) {
      const filter = wanted as Row;
      if (Array.isArray(filter.path)) {
        const nested = filter.path.reduce((current: unknown, part: string) =>
          current && typeof current === "object" ? (current as Row)[part] : undefined, value);
        return JSON.stringify(nested) === JSON.stringify(filter.equals);
      }
      return Object.entries(filter).every(([op, bound]) => {
        if (op === "in") return (bound as unknown[]).includes(value);
        if (op === "not") return value !== bound;
        if (op === "is") return matches(value as Row | null, bound as Row);
        if (op === "gt") return (value as number) > (bound as number);
        if (op === "gte") return (value as number) >= (bound as number);
        if (op === "lt") return (value as number) < (bound as number);
        if (op === "lte") return (value as number) <= (bound as number);
        if (op === "equals") return JSON.stringify(value) === JSON.stringify(bound);
        throw new Error(`Unsupported test filter ${op}`);
      });
    }
    return value instanceof Date && wanted instanceof Date ? value.getTime() === wanted.getTime() : value === wanted;
  });
}
function update(row: Row, data: Row) {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === "object" && "increment" in value
      ? Number(row[key] ?? 0) + Number(value.increment) : value;
  }
}

const now = new Date("2026-09-09T19:00:00Z");
const runtime = "a".repeat(40);
const secret = "source-flow-test-secret";
const parser = readFileSync(resolve("tools/local-chrome-reader/official-source-reader.js"), "utf8");
const courses = [
  { name: "Johnny Goodman Golf Course", heading: "Johnny Goodman Golf Course", street: "6111 S. 99th St.", path: "johnny-goodman-golf-course", facility: 13482, oldFacility: 13482 },
  { name: "Elmwood 18 Hole Golf Course", heading: "Elmwood Golf Course", street: "6232 Pacific St.", path: "elmwoodgolf-course", facility: 13481, oldFacility: 8336 },
];

function fixture(selected = courses[0]) {
  let ledger: unknown = null;
  for (const [stage, readPath] of [["OFFICIAL_IDENTITY", "OFFICIAL_IDENTITY"], ["TYPED_ADAPTER", "TYPED_PROVIDER_ADAPTER"],
    ["OFFICIAL_HTTP_DISCOVERY", "OFFICIAL_HTTP"], ["HTTP_ADAPTER_RETRY", "TYPED_PROVIDER_ADAPTER"]] as const) {
    ledger = appendAutomationPlaybookEvent(ledger, { cycle: 14, stage, readPath, transition: "COMPLETED", evidenceKind: "OFFICIAL_SOURCE",
      failureFingerprint: "SOURCE:CURRENT", runtimeVersion: runtime, observedAt: new Date(now.getTime() - 60_000) });
  }
  const fence = { courseId: "source-course", batchId: "source-batch", incidentId: "source-incident", ownerThreadId: "source-owner",
    leaseToken: "batch-lease", cycle: 14, runtimeVersion: runtime, releaseSha: runtime,
    deployedAt: new Date(now.getTime() - 120_000), stage: "RENDERED_BROWSER_DISCOVERY" as const };
  const identity = { id: fence.courseId, name: selected.name, address: `${selected.street}, Omaha, NE`, city: "Omaha", stateCode: "NE",
    timeZone: "America/Chicago", website: `https://parks.cityofomaha.org/${selected.path}/` };
  const course: Row = { ...identity, detectedBookingUrl: null, detectedPlatform: "UNKNOWN", providerFamilyKey: "SOURCE_MISSING",
    bookingMethod: "UNKNOWN", automationEligibility: "NEEDS_REVIEW", automationReason: "UNSUPPORTED_PLATFORM", monitoringMode: "AUTOMATIC",
    bookingWindowDaysAhead: null, bookingWindowEvidenceUrl: null, bookingReleaseTimeLocal: null, bookingWindowSource: null, bookingWindowConfidence: null,
    bookingAccessMode: "UNKNOWN", isPublic: true, intelligenceVerifiedAt: null, intelligenceReviewAt: null, intelligenceConfidence: null,
    bookingMetadata: null, layoutHoleCounts: [], layoutHolesVerifiedAt: null, updatedAt: new Date(now.getTime() - 60_000) };
  const incident: Row = { id: fence.incidentId, courseId: fence.courseId, cycle: fence.cycle, activeBatchId: fence.batchId,
    status: "AUTO_INVESTIGATING", revision: 1, attemptLedger: ledger, decisionAt: null };
  const batch: Row = { ...fence, id: fence.batchId, status: "VERIFYING", leaseExpiresAt: new Date(now.getTime() + 600_000) };
  const jobs: Row[] = [];
  db.course.findUnique.mockImplementation(async () => ({ ...course }));
  db.course.updateMany.mockImplementation(async ({ where, data }) => {
    if (!matches(course, where)) return { count: 0 }; update(course, data); return { count: 1 };
  });
  db.courseSupportIncident.findUnique.mockImplementation(async () => ({ ...incident }));
  db.courseSupportIncident.findMany.mockResolvedValue([]);
  db.courseSupportIncident.updateMany.mockImplementation(async ({ where, data }) => {
    if (!matches(incident, where)) return { count: 0 }; update(incident, data); return { count: 1 };
  });
  db.courseSupportBatch.findUnique.mockImplementation(async () => ({ ...batch }));
  db.courseSupportBatch.findFirst.mockResolvedValue(null);
  db.courseSupportBatch.updateMany.mockImplementation(async ({ where }) => ({ count: matches(batch, where) ? 1 : 0 }));
  db.courseSupportBatchIncident.findUnique.mockResolvedValue({ courseId: fence.courseId, cycle: fence.cycle, result: "PENDING" });
  db.localReaderJob.create.mockImplementation(async ({ data }) => {
    const row = { teeSearchId: null, scheduleVersion: null, status: "PENDING", leaseToken: null, leaseExpiresAt: null,
      claimedAt: null, completedAt: null, result: null, ...data }; jobs.push(row); return { ...row };
  });
  db.localReaderJob.findUnique.mockImplementation(async ({ where }) => {
    const found = jobs.find(row => matches(row, where)); return found ? { ...found } : null;
  });
  db.localReaderJob.findMany.mockImplementation(async ({ where }) => jobs.filter(row => matches(row, where)).map(row => ({ ...row })));
  db.localReaderJob.findFirst.mockImplementation(async ({ where }) => {
    const found = jobs.find(row => matches(row, where)); return found ? { ...found } : null;
  });
  db.localReaderJob.updateMany.mockImplementation(async ({ where, data }) => {
    const matching = jobs.filter(row => matches(row, where)); matching.forEach(row => update(row, data)); return { count: matching.length };
  });
  db.courseAutomationDiscovery.create.mockImplementation(async ({ data }) => ({ id: "source-discovery", ...data }));
  return { selected, fence, identity, course, incident, batch, jobs,
    input: { fence, course: identity, providerSnapshotFingerprint: buildCourseSupportProviderSnapshotFingerprint(course as never) } };
}

beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv("LOCAL_READER_DEVICE_TOKEN", secret);
  db.$transaction.mockImplementation(async worker => worker(db));
  db.$queryRaw.mockImplementation(async () => [{ now: new Date(), currentTime: new Date(), updatedAt: new Date() }]);
  db.localReaderAgent.findUnique.mockResolvedValue(null);
  db.courseMonitoringStatus.findUnique.mockResolvedValue(null);
  db.courseMonitoringEvent.findFirst.mockResolvedValue(null);
  marker.beginCourseProviderObservationInTransaction.mockImplementation(async (_tx, input) => ({ ...input,
    observationStartedAt: new Date(), leaseExpiresAt: new Date(Date.now() + input.ttlMs), supersededUnresolvedObservationStartedAt: null }));
  marker.renewCourseProviderObservationInTransaction.mockResolvedValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); document.body.innerHTML = ""; });

async function claimedObservation(state: ReturnType<typeof fixture>, restricted = false) {
  expect(await getOwnedOfficialSourceObservation(state.input)).toEqual({ status: "PENDING" });
  expect(await getOwnedOfficialSourceObservation(state.input)).toEqual({ status: "PENDING" });
  expect(state.jobs).toHaveLength(1);
  const wire = await claimNextLocalReaderJob({ deviceId: "controlled-reader", readerVersion: "1.12.0", buildId: "controlled-1.12.0",
    capabilities: [{ key: "OFFICIAL_SOURCE_RENDERED", parserVersion: 2 }] });
  if (!wire || !("purpose" in wire)) throw new Error("Source claim missing");
  vi.setSystemTime(new Date(now.getTime() + 1_000));
  const context = { URL, document, TeeTimeOfficialSourceReader: undefined as unknown as {
    readPage: (document: Document, url: string, expected: typeof wire.course) => OfficialSourcePage } };
  runInNewContext(parser, context);
  document.body.innerHTML = `<span class="elementor-heading-title">${state.selected.heading.toLowerCase()}</span>
    <span class="elementor-heading-title">${state.selected.heading}</span><p>${state.selected.street}</p><footer>Omaha, NE</footer>
    <a href="https://city-of-omaha.book.teeitup.com/?course=${state.selected.oldFacility}">Book a Tee Time</a>`;
  if (restricted) document.body.innerHTML = `<h1>403 - Access Denied</h1><p>This service is not available in your region.</p>`;
  const result = { purpose: "OFFICIAL_SOURCE_DISCOVERY", jobId: wire.id, contextKey: wire.contextKey, readerVersion: "official-source-v1",
    observedAt: new Date().toISOString(), pages: [context.TeeTimeOfficialSourceReader.readPage(document,
      wire.sourceUrl + (restricted ? "?bm-verify=opaque-test-value" : ""), wire.course)] };
  return { wire, result };
}

const sourceHandshake = { deviceId: "controlled-reader", readerVersion: "1.12.0", buildId: "build-1",
  capabilities: [{ key: "OFFICIAL_SOURCE_RENDERED" as const, parserVersion: 2 }] };

function exhaustedSource(selected = courses[0], existing?: ReturnType<typeof fixture>) {
  const state = existing ?? fixture(selected);
  let ledger: unknown = null;
  const paths = ["OFFICIAL_IDENTITY", "TYPED_PROVIDER_ADAPTER", "OFFICIAL_HTTP", "TYPED_PROVIDER_ADAPTER",
    "RENDERED_BROWSER", "TYPED_PROVIDER_ADAPTER", "LOCAL_READER", "INDEPENDENT_CONFIRMATION"] as const;
  AUTOMATION_PLAYBOOK_STAGES.forEach((stage, index) => {
    ledger = appendAutomationPlaybookEvent(ledger, { cycle: 14, stage, readPath: paths[index], transition: "COMPLETED",
      evidenceKind: "OFFICIAL_SOURCE", failureFingerprint: "SOURCE:CURRENT", runtimeVersion: runtime, observedAt: now });
  });
  const status: Row = { courseId: state.identity.id, revision: 3, state: "ENGINEERING_VERIFICATION_NEEDED" };
  Object.assign(state.incident, { attemptLedger: ledger, activeBatchId: null, status: "NEEDS_HUMAN", confirmedAt: now,
    engineeringOnly: true, resolvedAt: null, resolution: null, activeRealSearchCount: 0, failureFingerprint: "SOURCE:CURRENT" });
  state.course.monitoringStatus = status;
  const candidate = () => ({ ...state.incident, course: { ...state.course, monitoringStatus: { ...status } } });
  db.courseSupportIncident.findMany.mockImplementation(async () => [candidate()]);
  db.courseSupportIncident.findUnique.mockImplementation(async () => candidate());
  db.courseMonitoringStatus.updateMany.mockImplementation(async ({ where, data }) => {
    if (!matches(status, where)) return { count: 0 }; update(status, data); return { count: 1 };
  });
  const events: Row[] = [];
  db.courseMonitoringEvent.findUnique.mockImplementation(async ({ where }) => events.find(event => matches(event, where)) ?? null);
  db.courseMonitoringEvent.create.mockImplementation(async ({ data }) => { const event = { id: `event-${events.length}`, ...data };
    events.push(event); return event; });
  return { ...state, status, events, candidate };
}

describe("new signed source capability revalidation", () => {
  it("does not reopen discovery when the current reader already returned a signed source result", async () => {
    const original = fixture(courses[1]);
    const { wire, result } = await claimedObservation(original, true);
    expect((await submit(wire, result)).status).toBe(200);
    expect((await getOwnedOfficialSourceObservation(original.input)).status).toBe("READY");
    expect(original.jobs[0]).toMatchObject({ status: "COMPLETED", requiredParserVersion: 2 });

    // Model normal closeout after this accepted observation; the heartbeat
    // must not treat a parser already exercised in that cycle as newly available.
    const state = exhaustedSource(courses[1], original);
    const history = JSON.stringify(state.incident.attemptLedger);
    await revalidateForOfficialSourceReader({ ...sourceHandshake, readerVersion: "1.12.2", buildId: "chrome-extension-1.12.2" });
    expect(state.incident.cycle).toBe(14);
    expect(state.events.filter(event => event.eventType === "REVALIDATION_REQUESTED")).toHaveLength(0);
    expect(JSON.stringify(state.incident.attemptLedger)).toBe(history);
    expect(state.jobs).toHaveLength(1);
    expect(db.teeSearch.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { label: "pending", changes: { status: "PENDING" } },
    { label: "expired", changes: { status: "EXPIRED" } },
    { label: "an older parser", changes: { requiredParserVersion: 1 } },
    { label: "another course", changes: { courseId: "another-course" } },
    { label: "missing its server claim", changes: { claimedAt: null } },
    { label: "missing its result", changes: { result: null } },
  ])("keeps the capability retry available when an earlier job is $label", async ({ changes }) => {
    const original = fixture();
    const { wire, result } = await claimedObservation(original, true);
    expect((await submit(wire, result)).status).toBe(200);
    Object.assign(original.jobs[0], changes);
    const state = exhaustedSource(courses[0], original);

    await revalidateForOfficialSourceReader(sourceHandshake);
    expect(state.incident.cycle).toBe(15);
    expect(state.events.filter(event => event.eventType === "REVALIDATION_REQUESTED")).toHaveLength(1);
  });

  it.each(courses)("reopens $name once with preserved history and an actionable normal discovery route", async selected => {
    const state = exhaustedSource(selected);
    const history = JSON.stringify(state.incident.attemptLedger);
    expect(assessAutomationPlaybook(state.incident.attemptLedger, 14).conclusion).toBe("UNRESOLVED_EXHAUSTED");
    await revalidateForOfficialSourceReader(sourceHandshake);
    expect(state.incident).toMatchObject({ cycle: 15, status: "AUTO_INVESTIGATING", nextAttemptAt: now, activeBatchId: null });
    expect(state.status).toMatchObject({ state: "AUTO_INVESTIGATING", nextAutomaticAttemptAt: now });
    expect(JSON.stringify(state.incident.attemptLedger)).toBe(history);
    const playbook = assessAutomationPlaybook(state.incident.attemptLedger, 15);
    expect(playbook).toMatchObject({ valid: true, conclusion: "INCOMPLETE", nextStage: "OFFICIAL_IDENTITY" });
    expect(routeCourseSupportRemediation({ ...state.course, failureClass: "MISSING_SOURCE", attemptCount: 0,
      playbookAssessment: playbook } as Parameters<typeof routeCourseSupportRemediation>[0])).toMatchObject({
      workMode: "ADVANCE_DISCOVERY", attemptSignature: { playbookStage: "OFFICIAL_IDENTITY" } });
    db.courseSupportIncident.findMany.mockImplementation(async ({ where }) =>
      where.status === "AUTO_INVESTIGATING" ? [{ ...state.candidate(), firstSeenAt: now,
        providerFamilyKey: "SOURCE_MISSING", course: { ...state.course, preferences: [] } }] : []);
    db.courseSupportBatch.findMany.mockResolvedValue([]);
    db.automationRun.findFirst.mockResolvedValue(null);
    expect(await inspectCourseSupportQueue({ now })).toMatchObject({ outcome: "ready", dueIncidentCount: 1 });
    await revalidateForOfficialSourceReader({ ...sourceHandshake, readerVersion: "1.12.1", buildId: "different-build" });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ source: "LOCAL_READER", audit: { priorCycle: 14, cycle: 15,
      preservesPriorAttemptEvents: true, customerDataIncluded: false } });
    expect(db.teeSearch.updateMany).not.toHaveBeenCalled(); expect(db.teeTimeMatch.updateMany).not.toHaveBeenCalled();
  });
  it("retries a busy course on a later heartbeat and never reopens a consumed capability after another exhaustion", async () => {
    const state = exhaustedSource(); state.incident.activeBatchId = "existing-owner";
    await revalidateForOfficialSourceReader(sourceHandshake); expect(state.events).toHaveLength(0);
    state.incident.activeBatchId = null;
    await revalidateForOfficialSourceReader(sourceHandshake); expect(state.events).toHaveLength(1);
    // Historical state restored only inside this test to prove the durable event,
    // rather than current playbook incompleteness, prevents a second admission.
    state.incident.cycle = 14; state.incident.status = "NEEDS_HUMAN";
    await revalidateForOfficialSourceReader({ ...sourceHandshake, buildId: "newer" });
    expect(state.events).toHaveLength(1); expect(state.incident.cycle).toBe(14);
  });
  it.each(["final", "operator exclusion", "wrong origin", "missing address", "unconfirmed", "incomplete", "ownership race"])(
    "does not reopen %s", async scenario => {
      const state = exhaustedSource();
      if (scenario === "final") state.incident.resolution = "TECHNICAL_LIMITATION_CLASSIFIED";
      if (scenario === "operator exclusion") state.course.monitoringMode = "DISABLED";
      if (scenario === "wrong origin") state.course.website = "https://example.org/course";
      if (scenario === "missing address") state.course.address = null;
      if (scenario === "unconfirmed") { state.incident.confirmedAt = null; state.incident.engineeringOnly = false; }
      if (scenario === "incomplete") state.incident.cycle = 15;
      if (scenario === "ownership race") db.courseSupportIncident.findUnique.mockImplementation(async () => ({
        ...state.candidate(), activeBatchId: "successor" }));
      else expect(canRevalidateOfficialSource(state.candidate() as never)).toBe(false);
      await revalidateForOfficialSourceReader(sourceHandshake); expect(state.events).toHaveLength(0);
      expect(db.courseSupportIncident.updateMany).not.toHaveBeenCalled();
    });
  it.each([{ key: "CPS_RENDERED" as const, parserVersion: 2 }, { key: "OFFICIAL_SOURCE_RENDERED" as const, parserVersion: 1 }])(
    "does not inspect or mutate courses without the new parser: %j", async capability => {
    exhaustedSource(); await revalidateForOfficialSourceReader({ ...sourceHandshake, capabilities: [capability] });
    expect(db.courseSupportIncident.findMany).not.toHaveBeenCalled(); expect(db.$transaction).not.toHaveBeenCalled();
  });
});
async function submit(wire: { id: string; leaseToken: string }, result: unknown, badSignature = false) {
  const path = `/api/local-reader/jobs/${wire.id}/result`, body = JSON.stringify(result), timestamp = String(Date.now());
  const request = new NextRequest(`https://teetimespot.com${path}`, { method: "POST", body, headers: {
    "x-local-reader-lease": wire.leaseToken, "x-local-reader-timestamp": timestamp,
    "x-local-reader-signature": signLocalReaderPayload(secret, `POST\n${path}\n${timestamp}\n${badSignature ? body + "x" : body}`),
  } });
  return POST(request, { params: Promise.resolve({ id: wire.id }) });
}

describe("native owned official-source flow", () => {
  it("accepts and retains a signed denial without projecting course identity or sending alerts", async () => {
    const state = fixture(); const { wire, result } = await claimedObservation(state, true);
    expect((await submit(wire, result)).status).toBe(200);
    const ready = await getOwnedOfficialSourceObservation(state.input);
    expect(ready.status).toBe("READY");
    if (ready.status !== "READY") throw new Error("Missing completed restriction");
    expect(ready.result.pages[0]).toMatchObject({ pageUrl: wire.sourceUrl, status: "ACCESS_RESTRICTED",
      courseName: null, street: null, city: null, stateCode: null, bookingLinks: [], nextUrls: [] });
    expect(JSON.stringify(state.jobs[0].result)).not.toContain("opaque-test-value");
    expect(db.course.updateMany).not.toHaveBeenCalled(); expect(db.teeSearch.updateMany).not.toHaveBeenCalled();
    expect(db.teeTimeMatch.updateMany).not.toHaveBeenCalled();
  });
  it.each(courses)("queues, authenticates, consumes and projects $name without sending alerts", async selected => {
    const state = fixture(selected); const originalLedger = JSON.stringify(state.incident.attemptLedger);
    const { wire, result } = await claimedObservation(state);
    expect((await submit(wire, result)).status).toBe(200);
    expect(db.teeSearch.updateMany).not.toHaveBeenCalled(); expect(db.teeTimeMatch.updateMany).not.toHaveBeenCalled();
    expect((await submit(wire, result)).status).toBe(409);
    expect(state.jobs[0].result).toMatchObject({ observedAt: now.toISOString() });
    const ready = await getOwnedOfficialSourceObservation(state.input);
    expect(ready.status).toBe("READY"); if (ready.status !== "READY") throw new Error("Missing completed source");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([{ id: selected.facility, name: selected.heading,
      address: state.identity.address, timeZone: state.identity.timeZone }]));
    const discovery = await discoverFromOfficialSource({ ...ready, cycle: state.fence.cycle, runtimeVersion: runtime, stage: state.fence.stage,
      fetchImpl, runWithProviderLease: async (_family, worker) => ({ acquired: true, value: await worker() }) });
    if (discovery.status !== "OBSERVED") throw new Error("Missing discovery");
    const applied = await recordAndApplyOwnedBrowserDiscoveryToCourse(discovery.discovery, discovery.discovery, state.fence, runtime,
      state.input.providerSnapshotFingerprint, { courseId: state.identity.id, leaseToken: "verifier-observation",
        observationStartedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 120_000), ttlMs: 120_000,
        supersededUnresolvedObservationStartedAt: null }, new Date());
    expect(applied.snapshotBound).toBe(true); expect(applied.applied).toBeTruthy();
    expect(state.course.bookingMetadata).toMatchObject({ facilityIds: [selected.facility] });
    expect(resolveProviderCapability(state.course as never).isRunnable).toBe(true);
    expect(JSON.stringify(state.incident.attemptLedger)).toBe(originalLedger);
    expect(state.incident.status).toBe("AUTO_INVESTIGATING");
    expect(db.teeSearch.updateMany).not.toHaveBeenCalled();
    // Existing projection correctly invalidates old availability after changing
    // provider identity; it does not manufacture fresh matches or delivery.
    expect(db.teeTimeMatch.updateMany).toHaveBeenCalledWith({ where: {
      courseId: state.identity.id, availabilityStatus: "AVAILABLE", lastConfirmedAt: { lte: new Date() },
    }, data: { availabilityStatus: "UNKNOWN", availabilityCycle: { increment: 1 } } });
    expect(marker.releaseCourseProviderObservationInTransaction).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each(["owner", "cycle", "source", "identity", "runtime"])("rejects %s drift after completion before consuming source evidence", async scenario => {
    const state = fixture(); const { wire, result } = await claimedObservation(state);
    expect((await submit(wire, result)).status).toBe(200);
    if (scenario === "owner") state.batch.ownerThreadId = "successor";
    if (scenario === "cycle") state.incident.cycle = 15;
    if (scenario === "source") state.course.website = "https://parks.cityofomaha.org/different/";
    if (scenario === "identity") state.course.name = "Different Golf Course";
    if (scenario === "runtime") state.batch.releaseSha = "b".repeat(40);
    await expect(getOwnedOfficialSourceObservation(state.input)).rejects.toThrow();
    expect(db.course.updateMany).not.toHaveBeenCalled(); expect(db.courseAutomationDiscovery.create).not.toHaveBeenCalled();
    expect(db.teeSearch.updateMany).not.toHaveBeenCalled();
  });
  it.each(["owner", "cycle", "source", "expired batch", "expired job", "bad signature", "wrong lease"])("rejects %s before source completion", async scenario => {
    const state = fixture(); const { wire, result } = await claimedObservation(state);
    if (scenario === "owner") state.batch.ownerThreadId = "successor";
    if (scenario === "cycle") state.incident.cycle = 15;
    if (scenario === "source") state.course.website = "https://parks.cityofomaha.org/different/";
    if (scenario === "expired batch") state.batch.leaseExpiresAt = now;
    if (scenario === "expired job") vi.setSystemTime(new Date(now.getTime() + 300_001));
    if (scenario === "wrong lease") wire.leaseToken = "incorrect";
    expect((await submit(wire, result, scenario === "bad signature")).status).toBe(scenario === "bad signature" ? 401 : 409);
    expect(state.jobs[0].result).toBeNull(); expect(db.course.updateMany).not.toHaveBeenCalled();
    expect(db.courseAutomationDiscovery.create).not.toHaveBeenCalled(); expect(db.teeSearch.updateMany).not.toHaveBeenCalled();
  });
});
