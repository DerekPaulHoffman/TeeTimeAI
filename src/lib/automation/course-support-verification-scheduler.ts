import { start } from "workflow/api";

import {
  COURSE_SUPPORT_VERIFICATION_MAX_DUE,
  attachCourseSupportVerificationWorkflow,
  claimCourseSupportVerificationRequest,
  failCourseSupportVerificationRequest,
  listDueCourseSupportVerificationRequests,
} from "@/lib/automation/course-support-verification";
import { getAutomationRuntimeVersion } from "@/lib/automation/runtime-version";
import { courseSupportVerificationWorkflow } from "@/workflows/course-support-verification";
import type { CourseSupportVerificationWorkflowInput } from "@/workflows/course-support-verification-contracts";

const COURSE_SUPPORT_VERIFICATION_START_RETRY_MS = 2 * 60 * 1000;
export const COURSE_SUPPORT_VERIFICATION_MAX_STARTS_PER_PASS =
  COURSE_SUPPORT_VERIFICATION_MAX_DUE;

export type CourseSupportVerificationRecoveryResult = {
  considered: number;
  started: number;
  skipped: number;
  failed: number;
};

export async function recoverDueCourseSupportVerificationRequests(
  input: { now?: Date; limit?: number } = {},
): Promise<CourseSupportVerificationRecoveryResult> {
  // An injected time intentionally stays fixed for deterministic callers and
  // tests. Live recovery can process a full batch sequentially, so refresh the
  // clock before every deadline-sensitive durable transition.
  const currentTime = () => input.now ?? new Date();
  const listTime = currentTime();
  const runtimeVersion = getAutomationRuntimeVersion();
  const due = await listDueCourseSupportVerificationRequests({
    now: listTime,
    limit: input.limit ?? COURSE_SUPPORT_VERIFICATION_MAX_STARTS_PER_PASS,
    runtimeVersion,
  });
  const result: CourseSupportVerificationRecoveryResult = {
    considered: due.length,
    started: 0,
    skipped: 0,
    failed: 0,
  };

  for (const request of due) {
    try {
      const claimTime = currentTime();
      const claim = await claimCourseSupportVerificationRequest({
        requestId: request.id,
        expectedRevision: request.revision,
        runtimeVersion,
        now: claimTime,
      });
      if (!claim.claimed) {
        result.skipped += 1;
        continue;
      }

      const workflowInput: CourseSupportVerificationWorkflowInput = {
        requestId: claim.requestId,
        expectedRevision: claim.revision,
        leaseToken: claim.leaseToken,
        runtimeVersion: claim.runtimeVersion,
      };

      let run: { runId: string };
      try {
        // Omitting deploymentId makes WDK resolve this run to the caller's
        // immutable current deployment. `latest` would cross deployments.
        run = await start(courseSupportVerificationWorkflow, [workflowInput]);
      } catch {
        await persistStartFailure(claim, currentTime());
        result.failed += 1;
        continue;
      }

      const attachment = await attachCourseSupportVerificationWorkflow({
        requestId: claim.requestId,
        expectedRevision: claim.revision,
        leaseToken: claim.leaseToken,
        runtimeVersion: claim.runtimeVersion,
        workflowRunId: run.runId,
        now: currentTime(),
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
  now: Date,
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
        now.getTime() + COURSE_SUPPORT_VERIFICATION_START_RETRY_MS,
      ),
      now,
    });
  } catch {
    // The caller still counts the start as failed; an owned lease can be
    // reclaimed after expiry if the durable failure transition also failed.
  }
}
