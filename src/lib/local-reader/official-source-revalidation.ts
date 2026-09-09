import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";

import { getCourseMonitoringEscalationDeadline, runSerializedCourseMonitoringWrite } from "@/lib/automation/course-monitoring";
import { assessAutomationPlaybook } from "@/lib/automation/course-monitoring-playbook";
import { resolveProviderCapability } from "@/lib/automation/provider-capabilities";
import { prisma } from "@/lib/prisma";
import { normalizeOfficialSourceUrl, OFFICIAL_SOURCE_CAPABILITY, OFFICIAL_SOURCE_PARSER_VERSION } from "./official-source-contracts";
import { readerSupportsCapability, type LocalReaderAgentHandshake } from "./capabilities";

const parserVersion = OFFICIAL_SOURCE_PARSER_VERSION;
type Candidate = Prisma.CourseSupportIncidentGetPayload<{ include: { course: { include: { monitoringStatus: true } } } }>;

export function canRevalidateOfficialSource(incident: Candidate) {
  const course = incident.course;
  const state = course.monitoringStatus;
  return ["NEEDS_HUMAN", "AUTO_INVESTIGATING"].includes(incident.status) && incident.activeBatchId === null &&
    incident.decisionAt === null && incident.resolvedAt === null && incident.resolution === null &&
    (incident.confirmedAt != null || incident.engineeringOnly === true) &&
    course.isPublic === true && course.monitoringMode === "AUTOMATIC" &&
    typeof course.website === "string" && normalizeOfficialSourceUrl(course.website) !== null &&
    Boolean(course.address && course.city && course.stateCode && course.timeZone) &&
    state !== null && ["AUTO_INVESTIGATING", "ENGINEERING_VERIFICATION_NEEDED", "DEGRADED_RETRYING"].includes(state.state) &&
    !resolveProviderCapability(course).isRunnable &&
    assessAutomationPlaybook(incident.attemptLedger, incident.cycle).conclusion === "UNRESOLVED_EXHAUSTED";
}

/** An authenticated capability is a material change once per course/parser,
 * independent of build strings and incident cycles. Busy owners are retried by
 * later normal heartbeats; no candidate is reset merely because Git advanced.
 */
export async function revalidateForOfficialSourceReader(handshake: LocalReaderAgentHandshake) {
  if (!readerSupportsCapability(handshake.capabilities, OFFICIAL_SOURCE_CAPABILITY, parserVersion)) return;
  const candidates = await prisma.courseSupportIncident.findMany({
    where: { status: { in: ["NEEDS_HUMAN", "AUTO_INVESTIGATING"] }, activeBatchId: null, decisionAt: null,
      resolvedAt: null, resolution: null,
      course: { is: { isPublic: true, monitoringMode: "AUTOMATIC", OR: [
        { website: { startsWith: "https://parks.cityofomaha.org/" } }, { website: { startsWith: "http://parks.cityofomaha.org/" } },
      ] } },
      monitoringEvents: { none: { eventType: "REVALIDATION_REQUESTED", source: "LOCAL_READER", readPath: OFFICIAL_SOURCE_CAPABILITY,
        audit: { path: ["parserVersion"], equals: parserVersion } } },
    },
    orderBy: [{ activeRealSearchCount: "desc" }, { createdAt: "asc" }], take: 20,
    include: { course: { include: { monitoringStatus: true } } },
  });
  for (const candidate of candidates) {
    if (!canRevalidateOfficialSource(candidate)) continue;
    await runSerializedCourseMonitoringWrite(candidate.courseId, async transaction => {
      await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "Course" WHERE "id" = ${candidate.courseId} FOR UPDATE`);
      const clock = await transaction.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
      const now = clock[0]?.now;
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Reader revalidation database clock unavailable");
      const incident = await transaction.courseSupportIncident.findUnique({ where: { id: candidate.id },
        include: { course: { include: { monitoringStatus: true } } } });
      if (!incident || !canRevalidateOfficialSource(incident)) return;
      const key = `official-source-capability:${createHash("sha256").update(`${incident.courseId}:${parserVersion}`).digest("hex")}`;
      if (await transaction.courseMonitoringEvent.findUnique({ where: { idempotencyKey: key }, select: { id: true } })) return;
      const status = incident.course.monitoringStatus!;
      const changed = await transaction.courseSupportIncident.updateMany({ where: {
        id: incident.id, cycle: incident.cycle, revision: incident.revision, status: incident.status,
        activeBatchId: null, decisionAt: null, resolvedAt: null, resolution: null,
      }, data: { cycle: { increment: 1 }, revision: { increment: 1 }, status: "AUTO_INVESTIGATING", humanReviewReason: null,
        nextReminderAt: null, nextAttemptAt: now, escalationDeadlineAt: getCourseMonitoringEscalationDeadline(now, incident.activeRealSearchCount),
        latestMessage: "A signed official-source reader capability became available; normal course discovery is queued." } });
      if (changed.count !== 1) return;
      const statusChanged = await transaction.courseMonitoringStatus.updateMany({ where: {
        courseId: incident.courseId, revision: status.revision, state: status.state,
      }, data: { state: "AUTO_INVESTIGATING", nextAutomaticAttemptAt: now, revalidationRequestedAt: now,
        stateChangedAt: now, revision: { increment: 1 } } });
      if (statusChanged.count !== 1) throw new Error("Official source revalidation lost monitoring ownership");
      await transaction.courseMonitoringEvent.create({ data: {
        courseId: incident.courseId, incidentId: incident.id, eventType: "REVALIDATION_REQUESTED", source: "LOCAL_READER",
        readPath: OFFICIAL_SOURCE_CAPABILITY, failureFingerprint: incident.failureFingerprint,
        fromState: status.state, toState: "AUTO_INVESTIGATING", occurredAt: now,
        idempotencyKey: key, message: "A newly available signed reader can investigate the retained public official source.",
        audit: { priorCycle: incident.cycle, cycle: incident.cycle + 1, parserVersion,
          readerVersion: handshake.readerVersion, buildId: handshake.buildId, preservesPriorAttemptEvents: true, customerDataIncluded: false },
      } });
    });
  }
}
