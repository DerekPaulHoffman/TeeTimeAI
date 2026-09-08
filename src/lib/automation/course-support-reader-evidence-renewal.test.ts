import { createHash } from "node:crypto";
import type { LocalReaderJob } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { getLocalReaderJobUrl } from "@/lib/local-reader/course-key";
import { createLocalReaderCourseVerificationKey } from "@/lib/local-reader/course-verification-key";
import { assessCourseSupportReaderEvidenceRenewal, createCourseSupportReaderRenewalJobFingerprint,
  readCourseSupportReaderRenewalJobs, readCourseSupportReaderRenewalQueueGuard, READER_EVIDENCE_RENEWAL_BASIS } from "./course-support-reader-evidence-renewal";

function fixture() {
  const at = (seconds: number) => new Date(Date.parse("2026-08-22T10:00:00.000Z") + seconds * 1000);
  const now = new Date("2026-09-08T17:00:00.000Z");
  const courseKey = "cps:fixture.cps.golf" as const;
  const job: LocalReaderJob = {
    id: "historical-fixture", courseId: "course-fixture", teeSearchId: null, scheduleVersion: null,
    purpose: "COURSE_VERIFICATION", verificationKey: createLocalReaderCourseVerificationKey("course-fixture", "2026-08-22", 1),
    courseKey, targetDate: "2026-08-22", players: 1, bookingUrl: getLocalReaderJobUrl(courseKey, "2026-08-22", 1),
    status: "COMPLETED", leaseToken: null, leaseExpiresAt: null, claimedAt: at(30), deviceId: "fixture-reader",
    createdAt: at(22), completedAt: at(40), updatedAt: at(40), jobExpiresAt: at(600), resultExpiresAt: at(640),
    readerVersion: "cps-rendered-v1", requiredCapabilityKey: "CPS_RENDERED", requiredParserVersion: 1,
    resumeFromScheduleVersion: null, resumeScheduleVersion: null,
    result: { jobId: "historical-fixture", courseKey, status: "NO_AVAILABILITY", observedAt: at(35).toISOString(),
      pageUrl: "https://fixture.cps.golf/onlineresweb/search-teetime", pageTitle: "Public fixture", slots: [], readerVersion: "cps-rendered-v1" },
  };
  return { job, at, input: { jobs: [job], courseId: job.courseId, courseName: "Public fixture", bookingUrl: job.bookingUrl,
    requiredCapabilityKey: "CPS_RENDERED", requiredParserVersion: 1, targetDateLocal: job.targetDate, players: 1,
    startedReaderAt: at(21), requestUpdatedAt: at(1200), batchCompletedAt: at(1200),
    currentIntent: { targetDateLocal: "2026-09-08", players: 1 }, now } };
}

describe("one-shot legacy reader evidence renewal", () => {
  it("uses the identical native key and never credits legacy output as fresh proof", () => {
    const { job, input } = fixture();
    const before = JSON.stringify(job);
    expect(job.verificationKey).toBe(createHash("sha256").update(["local-reader-course-verification", job.courseId, job.targetDate, 1].join("\n")).digest("hex"));
    expect(assessCourseSupportReaderEvidenceRenewal(input)).toMatchObject({ kind: READER_EVIDENCE_RENEWAL_BASIS,
      historicalJobFingerprint: createCourseSupportReaderRenewalJobFingerprint(job), historicalTargetDate: "2026-08-22", newTargetDateAtAdmission: "2026-09-08" });
    expect(JSON.stringify(job)).toBe(before);
  });
  it.each<[string, (f: ReturnType<typeof fixture>) => void]>([
    ["missing query evidence", f => { f.input.jobs = null as never; }],
    ["no historical job", f => { f.input.jobs = []; }],
    ["another completed job", f => { f.input.jobs.push({ ...f.job, id: "other" }); }],
    ["active job", f => { f.job.status = "LEASED"; }],
    ["anchored result", f => { Object.assign(f.job.result!, { evidenceAnchor: "SERVER_CLAIM" }); }],
    ["anchor time equality", f => { Object.assign(f.job.result!, { observedAt: f.job.claimedAt!.toISOString() }); }],
    ["observation before claim", f => { Object.assign(f.job.result!, { observedAt: f.at(25).toISOString() }); }],
    ["observation after completion", f => { Object.assign(f.job.result!, { observedAt: f.at(41).toISOString() }); }],
    ["wrong actual parser", f => { f.job.readerVersion = "cps-rendered-v2"; Object.assign(f.job.result!, { readerVersion: "cps-rendered-v2" }); }],
    ["required parser mismatch", f => { f.job.requiredParserVersion = 2; }],
    ["page mismatch result", f => { Object.assign(f.job.result!, { status: "PAGE_MISMATCH" }); }],
    ["reader error result", f => { Object.assign(f.job.result!, { status: "READER_ERROR" }); }],
    ["challenge result", f => { Object.assign(f.job.result!, { status: "ACCESS_CHALLENGE" }); }],
    ["other course", f => { f.job.courseId = "other"; }],
    ["conflicting result identity", f => { Object.assign(f.job.result!, { jobId: "other" }); }],
    ["unsafe page", f => { Object.assign(f.job.result!, { pageUrl: "https://fixture.cps.golf/checkout" }); }],
    ["other page host", f => { Object.assign(f.job.result!, { pageUrl: "https://other.cps.golf/onlineresweb/search-teetime" }); }],
    ["changed canonical stored URL", f => { f.job.bookingUrl += "?changed=1"; }],
    ["noncanonical old key", f => { f.job.verificationKey = "f".repeat(64); }],
    ["same date", f => { f.input.currentIntent.targetDateLocal = f.job.targetDate; }],
    ["invalid date", f => { f.input.currentIntent.targetDateLocal = "2026-02-31"; }],
    ["not expired", f => { f.job.resultExpiresAt = new Date(f.input.now.getTime() + 1000); }],
    ["completed before reader stage", f => { f.input.startedReaderAt = f.at(23); }],
    ["completed after request", f => { f.input.requestUpdatedAt = f.at(39); }],
  ])("rejects %s", (_label, mutate) => { const f = fixture(); mutate(f); expect(assessCourseSupportReaderEvidenceRenewal(f.input)).toBeNull(); });

  it("reads only bounded current-source jobs and fails closed on unavailable models", async () => {
    const f = fixture(); const findMany = vi.fn().mockResolvedValue([f.job]);
    const input = { courseId: f.job.courseId, bookingUrl: f.job.bookingUrl, batchCreatedAt: f.at(0) };
    expect(await readCourseSupportReaderRenewalJobs({}, input)).toBeNull();
    expect(await readCourseSupportReaderRenewalJobs({ localReaderJob: { findMany } } as never, input)).toEqual([f.job]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2, where: expect.objectContaining({ courseId: f.job.courseId, courseKey: f.job.courseKey, purpose: "COURSE_VERIFICATION" }) }));
  });

  function queueFixture() {
    const f = fixture(); const proof = assessCourseSupportReaderEvidenceRenewal(f.input)!;
    const audit = { cycle: 8, oneShot: true, proofBasis: READER_EVIDENCE_RENEWAL_BASIS,
      priorRequestOutcome: null, priorRequestProviderExecution: "UNKNOWN", readerEvidenceRenewal: proof };
    const database = { courseMonitoringEvent: { findUnique: vi.fn().mockResolvedValue({ courseId: f.job.courseId, incidentId: "incident-fixture", source: "COURSE_SUPPORT_RESPONDER", eventType: "REVALIDATION_REQUESTED", audit }) },
      localReaderJob: { findUnique: vi.fn().mockResolvedValue(f.job) } };
    const input = { courseId: f.job.courseId, incidentId: "incident-fixture", cycle: 8, targetDate: "2026-09-08", players: 1, bookingUrl: f.job.bookingUrl };
    return { ...f, proof, audit, database, input };
  }
  it("guards the actual owned request tuple without changing the old job", async () => {
    const f = queueFixture(); const before = JSON.stringify(f.job);
    expect(await readCourseSupportReaderRenewalQueueGuard(f.database as never, f.input)).toEqual({ historicalVerificationKey: f.job.verificationKey });
    expect(JSON.stringify(f.job)).toBe(before);
  });
  it.each(["same tuple", "old row changed", "unknown made false", "wrong players", "wrong source", "invalid receipt"])("blocks queue for %s", async reason => {
    const f = queueFixture();
    if (reason === "same tuple") f.input.targetDate = f.job.targetDate;
    if (reason === "old row changed") f.job.updatedAt = f.at(41);
    if (reason === "unknown made false") f.audit.priorRequestProviderExecution = false as never;
    if (reason === "wrong players") f.input.players = 2;
    if (reason === "wrong source") f.input.bookingUrl = "https://other.cps.golf/onlineresweb/search-teetime";
    if (reason === "invalid receipt") f.proof.historicalVerificationKey = "bad";
    await expect(readCourseSupportReaderRenewalQueueGuard(f.database as never, f.input)).rejects.toThrow();
  });
  it("leaves ordinary direct reader continuation unchanged", async () => {
    const f = queueFixture(); f.database.courseMonitoringEvent.findUnique.mockResolvedValue(null);
    expect(await readCourseSupportReaderRenewalQueueGuard(f.database as never, f.input)).toBeUndefined();
    expect(f.database.localReaderJob.findUnique).not.toHaveBeenCalled();
  });
});
