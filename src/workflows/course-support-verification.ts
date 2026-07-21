import { executeCourseSupportVerificationStep } from "./course-support-verification-steps";

export type CourseSupportVerificationWorkflowInput = {
  requestId: string;
  expectedRevision: number;
  leaseToken: string;
  runtimeVersion: string;
};

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
