import "./load-local-env";

import {
  backfillCourseMonitoringLifecycle,
  reconcileCourseMonitoringLifecycle
} from "@/lib/automation/course-monitoring-backfill";
import {
  approveOperatorCourseTechnicalFinal,
  correctOperatorCourseBookingLink,
  humanReviewReasonSchema,
  loadOperatorCourseMonitoringDetail,
  reopenOperatorCourseTechnicalFinal,
  requestOperatorCourseRecheck
} from "@/lib/operator/course-monitoring";

async function main() {
  const [command = "inspect", ...args] = process.argv.slice(2);
  const apply = args.includes("--apply");
  const context = {
    actorId: apply ? requireOption(args, "--actor-id") : "operator-cli-dry-run",
    source: "OPERATOR_CLI" as const,
    apply,
    dispatchSearches: false
  };

  switch (command) {
    case "inspect": {
      const detail = await loadOperatorCourseMonitoringDetail(requireOption(args, "--course-ref"));
      writeResult(detail ? sanitizeDetail(detail) : { found: false });
      return;
    }
    case "backfill":
      writeResult(await backfillCourseMonitoringLifecycle({ apply }));
      return;
    case "reconcile":
      writeResult(
        await reconcileCourseMonitoringLifecycle({
          apply,
          actorId: apply ? requireOption(args, "--actor-id") : "operator-cli-dry-run"
        })
      );
      return;
    case "correct-link":
      writeResult(
        await correctOperatorCourseBookingLink(
          {
            ...commonMutationInput(args),
            bookingUrl: requireOption(args, "--booking-url"),
            evidenceUrl: requireOption(args, "--evidence-url"),
            note: requireOption(args, "--note")
          },
          context
        )
      );
      return;
    case "recheck":
      writeResult(
        await requestOperatorCourseRecheck(
          {
            ...commonMutationInput(args),
            note: requireOption(args, "--note")
          },
          context
        )
      );
      return;
    case "approve-final":
      writeResult(
        await approveOperatorCourseTechnicalFinal(
          {
            ...commonMutationInput(args),
            reason: humanReviewReasonSchema.parse(requireOption(args, "--reason")),
            evidenceUrl: requireOption(args, "--evidence-url"),
            note: requireOption(args, "--note")
          },
          context
        )
      );
      return;
    case "reopen":
      writeResult(
        await reopenOperatorCourseTechnicalFinal(
          {
            ...commonMutationInput(args),
            evidenceUrl: requireOption(args, "--evidence-url"),
            note: requireOption(args, "--note")
          },
          context
        )
      );
      return;
    default:
      throw new Error(
        "Unknown command. Use inspect, backfill, reconcile, correct-link, recheck, approve-final, or reopen."
      );
  }
}

function commonMutationInput(args: string[]) {
  return {
    reference: requireOption(args, "--course-ref"),
    statusRevision: requireInteger(args, "--status-revision"),
    incidentCycle: optionalInteger(args, "--incident-cycle"),
    incidentRevision: optionalRevision(args, "--incident-revision"),
    idempotencyKey: requireOption(args, "--idempotency-key")
  };
}

function sanitizeDetail(
  detail: NonNullable<Awaited<ReturnType<typeof loadOperatorCourseMonitoringDetail>>>
) {
  return {
    found: true,
    reference: detail.reference,
    state: detail.state,
    revision: detail.revision,
    lastSuccessfulAt: detail.lastSuccessfulAt,
    lastFailureAt: detail.lastFailureAt,
    nextAutomaticAttemptAt: detail.nextAutomaticAttemptAt,
    revalidationRequestedAt: detail.revalidationRequestedAt,
    activeRealAlerts: detail.activeRealAlerts,
    pendingDeliveries: detail.pendingDeliveries,
    course: detail.course,
    incident: detail.incident,
    timeline: detail.timeline.map((event) => {
      const { id, ...safeEvent } = event;
      void id;
      return safeEvent;
    })
  };
}

function requireOption(args: string[], name: string) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing required ${name} value.`);
  }
  return value;
}

function requireInteger(args: string[], name: string) {
  const value = Number(requireOption(args, name));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function optionalInteger(args: string[], name: string) {
  if (!args.includes(name)) {
    return null;
  }
  const value = Number(requireOption(args, name));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function optionalRevision(args: string[], name: string) {
  if (!args.includes(name)) {
    return null;
  }
  const value = Number(requireOption(args, name));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function writeResult(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  writeResult({
    outcome: "failed",
    message: error instanceof Error ? error.message : "Unknown course monitoring error"
  });
  process.exitCode = 1;
});
