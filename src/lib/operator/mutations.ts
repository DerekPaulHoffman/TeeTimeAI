import { withPostgresAdvisoryTextLease } from "@/lib/automation/lease";
import { COURSE_SUPPORT_WRITER_LANE } from "@/lib/automation/writer-lanes";
import { syntheticWebsiteTrafficClasses } from "@/lib/engagement/traffic-class";
import { prisma } from "@/lib/prisma";

export type IncidentRetryResult =
  | "queued"
  | "already_due"
  | "in_progress"
  | "manual_review"
  | "resolved"
  | "not_found"
  | "busy";

export async function resolveOperatorFeedback(feedbackId: string, now = new Date()) {
  const result = await prisma.websiteFeedback.updateMany({
    where: {
      id: feedbackId,
      resolvedAt: null,
      trafficClass: {
        notIn: [...syntheticWebsiteTrafficClasses]
      }
    },
    data: {
      resolvedAt: now
    }
  });

  return result.count > 0 ? "resolved" : "already_resolved";
}

export async function requestOperatorIncidentRetry(
  incidentId: string,
  now = new Date()
): Promise<IncidentRetryResult> {
  const lease = await withPostgresAdvisoryTextLease(
    prisma,
    COURSE_SUPPORT_WRITER_LANE,
    async () => {
      const incident = await prisma.courseSupportIncident.findUnique({
        where: { id: incidentId },
        select: {
          status: true,
          activeBatchId: true,
          nextAttemptAt: true
        }
      });

      if (!incident) return "not_found" as const;
      if (incident.status === "RESOLVED") return "resolved" as const;
      if (incident.status === "NEEDS_HUMAN") return "manual_review" as const;
      if (incident.activeBatchId) return "in_progress" as const;
      if (
        !incident.nextAttemptAt ||
        incident.nextAttemptAt.getTime() <= now.getTime()
      ) {
        return "already_due" as const;
      }

      const update = await prisma.courseSupportIncident.updateMany({
        where: {
          id: incidentId,
          status: "AUTO_INVESTIGATING",
          activeBatchId: null,
          nextAttemptAt: { gt: now }
        },
        data: {
          nextAttemptAt: now
        }
      });

      return update.count > 0 ? ("queued" as const) : ("already_due" as const);
    }
  );

  return lease.acquired ? lease.value : "busy";
}
