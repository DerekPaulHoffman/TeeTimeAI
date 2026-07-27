import { executeCourseSupportVerificationStep } from "./course-support-verification-steps";
import type { CourseSupportVerificationWorkflowInput } from "./course-support-verification-contracts";

export type { CourseSupportVerificationWorkflowInput } from "./course-support-verification-contracts";

export async function courseSupportVerificationWorkflow(
  input: CourseSupportVerificationWorkflowInput
) {
  "use workflow";

  console.log("[courseSupportVerificationWorkflow] START");
  const result = await executeCourseSupportVerificationStep(input);
  console.log(
    `[courseSupportVerificationWorkflow] DONE outcome=${result.outcome}`
  );
  return result;
}
