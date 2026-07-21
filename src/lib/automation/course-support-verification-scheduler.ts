import { start } from "workflow/api";

import {
  attachCourseSupportVerificationWorkflow,
  claimCourseSupportVerificationRequest,
  failCourseSupportVerificationRequest,
  listDueCourseSupportVerificationRequests
} from "@/lib/automation/course-support-verification";
import { getAutomationRuntimeVersion } from "@/lib/automation/runtime-version";
import {
  courseSupportVerificationWorkflow,
  type CourseSupportVerificationWorkflowInput
} from "@/workflows/course-support-verification";

const COURSE_SUPPORT_VERIFICATION_START_RETRY_MS = 2 * 60 * 1000;

export type CourseSupportVerificationRecoveryResult = {
  considered: number;
  started: number;
  skipped: number;
  failed: number;
};

export async function recoverDueCourseSupportVerificationRequests(
  input: { now?: Date; limit?: number } = {}
): Promise<CourseSupportVerificationRecoveryResult> {
  const now = input.now ?? new Date();
  const runtimeVersion = getAutomationRuntimeVersion();
  const due = await listDueCourseSupportVerificationRequests({
    now,
    limit: input.limit
  });
  const result: CourseSupportVerificationRecoveryResult = {
    considered: due.length,
    started: 0,
    skipped: 0,
    failed: 0
  };

  for (const request of due) {
    try {
      const claim = await claimCourseSupportVerificationRequest({
        requestId: request.id,
        expectedRevision: request.revision,
        runtimeVersion,
        now
      });
      if (!claim.claimed) {
        result.skipped += 1;
        continue;
      }

      const workflowInput: CourseSupportVerificationWorkflowInput = {
        requestId: claim.requestId,
        expectedRevision: claim.revision,
        leaseToken: claim.leaseToken,
        runtimeVersion: claim.runtimeVersion
      };

      let run: { runId: string };
      try {
        // Omitting deploymentId makes WDK resolve this run to the caller's
        // immutable current deployment. `latest` would cross deployments.
        run = await start(courseSupportVerificationWorkflow, [workflowInput]);
      } catch {
        await persistStartFailure(claim, now);
        result.failed += 1;
        continue;
      }

      const attachment = await attachCourseSupportVerificationWorkflow({
        requestId: claim.requestId,
        expectedRevision: claim.revision,
        leaseToken: claim.leaseToken,
        runtimeVersion: claim.runtimeVersion,
        workflowRunId: run.runId,
        now
      });
      if (!attachment.attached) {
        result.failed += 1;
        continue;
      }

      result.started += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}

async function persistStartFailure(
  claim: {
    requestId: string;
    revision: number;
    leaseToken: string;
    runtimeVersion: string;
  },
  now: Date
) {
  try {
    await failCourseSupportVerificationRequest({
      requestId: claim.requestId,
      expectedRevision: claim.revision,
      leaseToken: claim.leaseToken,
      runtimeVersion: claim.runtimeVersion,
      failureClass: "UNKNOWN",
      message: "Workflow start failed before verification execution.",
      retryAt: new Date(
        now.getTime() + COURSE_SUPPORT_VERIFICATION_START_RETRY_MS
      ),
      now
    });
  } catch {
    // The caller still counts the start as failed; an owned lease can be
    // reclaimed after expiry if the durable failure transition also failed.
  }
}
