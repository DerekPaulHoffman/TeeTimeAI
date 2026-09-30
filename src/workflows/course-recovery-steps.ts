import { executeRecoveryAttempt } from "@/lib/course-recovery/service";
import { activateVerifiedRecoveryDemands } from "@/lib/course-recovery/demand";
import type { RecoveryWorkflowInput } from "@/lib/course-recovery/contracts";

export async function executeCourseRecoveryStep(input: RecoveryWorkflowInput) {
  "use step";
  const result = await executeRecoveryAttempt(input);
  if (result.outcome === "VERIFIED") await activateVerifiedRecoveryDemands(input.requestId);
  return result;
}
