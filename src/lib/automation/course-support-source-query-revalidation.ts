import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { assessAutomationPlaybook, parseAutomationPlaybookLedger } from "./course-monitoring-playbook";
import { getCourseSupportSourceQueryChange } from "./course-support-source-search";
import { buildCourseSupportProviderSnapshotFingerprint } from "./course-support-verification";

const implementation = "official-source-query-identity-terms-v2";
const unownedUndecided = {
  status: "NEEDS_HUMAN", activeBatchId: null,
  decisionActorId: null, decisionAt: null, decisionNote: null,
  decisionEvidenceUrl: null, decisionIdempotencyKey: null,
  resolvedAt: null, resolution: null, resolutionMessage: null, resolutionNotifiedAt: null,
} satisfies Prisma.CourseSupportIncidentWhereInput;

export const sourceQueryRevalidationInclude = {
  course: { include: { monitoringStatus: true } },
  monitoringEvents: {
    where: { OR: [
      { readPath: "CODEX_EXACT_SOURCE_SEARCH" },
      { eventType: "HUMAN_REVIEW_REQUESTED" as const },
    ] },
    orderBy: { occurredAt: "desc" as const }, take: 100,
  },
} satisfies Prisma.CourseSupportIncidentInclude;
type Candidate = Prisma.CourseSupportIncidentGetPayload<{ include: typeof sourceQueryRevalidationInclude }>;

/** Recognize the actual obsolete negative search, not merely a new deployment. */
export function getSourceQueryRevalidationProof(incident: Candidate) {
  if (!incident.course || !incident.monitoringEvents) return null;
  const course = incident.course;
  const status = course.monitoringStatus;
  if (Object.entries(unownedUndecided).some(([key, value]) => incident[key as keyof Candidate] !== value) ||
    !incident.confirmedAt ||
    !["MISSING_SOURCE", "NETWORK"].includes(incident.failureClass) ||
    course.isPublic !== true || course.monitoringMode !== "AUTOMATIC" ||
    course.detectedPlatform !== "UNKNOWN" || course.bookingMetadata !== null ||
    course.bookingAccessMode !== "UNKNOWN" || course.bookingMethod !== "UNKNOWN" ||
    !["NONE", "UNSUPPORTED_PLATFORM"].includes(course.automationReason) ||
    status?.state !== "ENGINEERING_VERIFICATION_NEEDED" ||
    (status.lastSuccessfulAt && status.lastSuccessfulAt >= incident.confirmedAt) ||
    assessAutomationPlaybook(incident.attemptLedger, incident.cycle).conclusion !== "UNRESOLVED_EXHAUSTED") return null;

  const search = incident.monitoringEvents.find(event => event.readPath === "CODEX_EXACT_SOURCE_SEARCH" &&
    event.incidentId === incident.id && event.courseId === incident.courseId);
  const audit = search?.audit;
  if (!search || !audit || typeof audit !== "object" || Array.isArray(audit) ||
    audit.schemaVersion !== 1 || audit.action !== "OWNED_EXACT_SOURCE_SEARCH" || audit.incidentCycle !== incident.cycle ||
    audit.independentConfirmationRecorded !== true ||
    typeof audit.ownershipScopeDigest !== "string" || !/^[a-f0-9]{64}$/u.test(audit.ownershipScopeDigest) ||
    search.eventType !== "AUTOMATION_ATTEMPTED" || search.source !== "COURSE_SUPPORT_RESPONDER" ||
    search.occurredAt < incident.confirmedAt || search.operatorActorId !== null || search.evidenceUrl !== null) return null;
  if (audit.sourceSearchMode === "RETAINED_SOURCE_IDENTITY_RESEARCH"
    ? audit.providerSnapshotFingerprint !== buildCourseSupportProviderSnapshotFingerprint(course)
    : course.website !== null || course.detectedBookingUrl !== null) return null;
  // Older exhausted investigations retain a six-hour schedule and escalatedAt
  // from an earlier cycle. Bind to this cycle's actual closeout instead of
  // assuming that every historical endpoint used today's parking format.
  const endpoint = incident.monitoringEvents.find(event => {
    const data = event.audit;
    return event.incidentId === incident.id && event.courseId === incident.courseId &&
      event.eventType === "HUMAN_REVIEW_REQUESTED" && event.operatorActorId === null &&
      event.occurredAt >= search.occurredAt && data && typeof data === "object" && !Array.isArray(data) &&
      data.cycle === incident.cycle && data.playbookExhausted === true && data.customerState === "NEEDS_HUMAN_REVIEW";
  });
  if (!endpoint) return null;
  const terminal = parseAutomationPlaybookLedger(incident.attemptLedger)?.events
    .filter(event => event.cycle === incident.cycle && event.stage === "INDEPENDENT_CONFIRMATION").at(-1);
  if (!terminal || terminal.transition !== "FAILED_TERMINAL" || terminal.providerExecution === true ||
    terminal.evidenceKind !== "TOOLING" || terminal.readPath !== "INDEPENDENT_CONFIRMATION" ||
    terminal.failureClass !== "MISSING_SOURCE" ||
    !terminal.failureFingerprint.includes(":EXACT_SEARCH:NO_UNIQUE") ||
    new Date(terminal.observedAt) < incident.confirmedAt || new Date(terminal.observedAt) > endpoint.occurredAt) return null;
  const change = getCourseSupportSourceQueryChange({ identity: course,
    priorResult: audit.result, priorQueryDigest: audit.queryDigest });
  return change ? { ...change, sourceSearchEventId: search.id, closeoutEventId: endpoint.id } : null;
}

/** The existing recovery cron admits at most five courses per pass. It creates a
 * fresh ordinary investigation, retaining every historical attempt and result.
 * The capability key survives deployments and cycles, preventing retry churn.
 */
export async function revalidateCoursesForSourceQueryChange(deploymentSha: string, dependencies: {
  getCourseMonitoringEscalationDeadline: typeof import("./course-monitoring").getCourseMonitoringEscalationDeadline;
  runSerializedCourseMonitoringWrite: typeof import("./course-monitoring").runSerializedCourseMonitoringWrite;
}) {
  const { getCourseMonitoringEscalationDeadline, runSerializedCourseMonitoringWrite } = dependencies;
  const candidates = await prisma.courseSupportIncident.findMany({
    where: { ...unownedUndecided, failureClass: { in: ["MISSING_SOURCE", "NETWORK"] },
      course: { is: { isPublic: true, monitoringMode: "AUTOMATIC", detectedPlatform: "UNKNOWN",
        bookingAccessMode: "UNKNOWN", bookingMethod: "UNKNOWN" } },
      monitoringEvents: {
        some: { readPath: "CODEX_EXACT_SOURCE_SEARCH", audit: { path: ["result"], equals: "NO_UNIQUE" } },
        none: { eventType: "REVALIDATION_REQUESTED", readPath: implementation },
      },
    },
    include: sourceQueryRevalidationInclude,
    orderBy: [{ activeRealSearchCount: "desc" }, { createdAt: "asc" }], take: 100,
  });
  const eligible = candidates.filter(candidate => getSourceQueryRevalidationProof(candidate)).slice(0, 5);
  let requeued = 0;
  for (const candidate of eligible) {
    const changed = await runSerializedCourseMonitoringWrite(candidate.courseId, async transaction => {
      await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "Course" WHERE "id" = ${candidate.courseId} FOR UPDATE`);
      const incident = await transaction.courseSupportIncident.findUnique({ where: { id: candidate.id }, include: sourceQueryRevalidationInclude });
      const proof = incident && getSourceQueryRevalidationProof(incident);
      if (!incident || !proof) return false;
      const idempotencyKey = `${implementation}:${incident.courseId}`;
      if (await transaction.courseMonitoringEvent.findUnique({ where: { idempotencyKey }, select: { id: true } })) return false;
      const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
      if (!(clock?.now instanceof Date) || !Number.isFinite(clock.now.getTime())) throw new Error("Source query revalidation database clock unavailable");
      const now = clock.now;
      const status = incident.course.monitoringStatus!;
      const updated = await transaction.courseSupportIncident.updateMany({
        where: { ...unownedUndecided, id: incident.id, cycle: incident.cycle, revision: incident.revision,
          nextAttemptAt: incident.nextAttemptAt },
        data: { cycle: { increment: 1 }, revision: { increment: 1 }, status: "AUTO_INVESTIGATING", confirmedAt: now,
          humanReviewReason: null, nextReminderAt: null, nextAttemptAt: now,
          escalationDeadlineAt: getCourseMonitoringEscalationDeadline(now, incident.activeRealSearchCount),
          latestMessage: "An improved official course search is available; normal discovery is queued." },
      });
      if (updated.count !== 1) return false;
      const updatedStatus = await transaction.courseMonitoringStatus.updateMany({
        where: { courseId: incident.courseId, revision: status.revision, state: status.state },
        data: { state: "AUTO_INVESTIGATING", stateChangedAt: now, nextAutomaticAttemptAt: now,
          revalidationRequestedAt: now, revision: { increment: 1 } },
      });
      if (updatedStatus.count !== 1) throw new Error("Source query revalidation lost monitoring ownership");
      await transaction.courseMonitoringEvent.create({ data: {
        courseId: incident.courseId, incidentId: incident.id, eventType: "REVALIDATION_REQUESTED", source: "RECOVERY_CRON",
        readPath: implementation, idempotencyKey, runtimeVersion: deploymentSha, deploymentSha,
        failureFingerprint: incident.failureFingerprint, fromState: status.state, toState: "AUTO_INVESTIGATING", occurredAt: now,
        message: "The official source search now tolerates course name and address formatting differences.",
        audit: { action: "relevant_discovery_implementation_changed", implementation, ...proof,
          priorCycle: incident.cycle, cycle: incident.cycle + 1, preservesPriorAttemptEvents: true, customerDataIncluded: false },
      } });
      return true;
    });
    if (changed) requeued += 1;
  }
  return { considered: eligible.length, requeued, retainedAuthoritativeFinals: 0 };
}
