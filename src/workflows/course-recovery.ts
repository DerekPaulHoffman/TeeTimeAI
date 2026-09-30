import { executeCourseRecoveryStep } from "./course-recovery-steps";
import type { RecoveryWorkflowInput } from "@/lib/course-recovery/contracts";

export async function courseRecoveryWorkflow(input: RecoveryWorkflowInput) {
  "use workflow";
  return executeCourseRecoveryStep(input);
}
