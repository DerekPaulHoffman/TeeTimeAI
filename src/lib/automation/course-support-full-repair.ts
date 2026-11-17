/** A failed reader is an engineering mission, not a succession of verifier
 * assignments. Negative deployed evidence stays with the same lease owner. */
export function shouldContinueOwnedFullRepair(packet: {
  remediation: { reason: string | null } | null;
  courses: readonly {
    result: string;
    terminalProofDurable: boolean;
    actionPlan: { allowedActions: readonly string[] } | null;
  }[];
}) {
  return packet.remediation?.reason === "FAILED_LEARNER_IMPLEMENTATION_HANDOFF" &&
    packet.courses.length === 1 &&
    packet.courses.every(course => course.actionPlan?.allowedActions.includes("INVESTIGATE_PUBLIC_SOURCE") &&
      course.actionPlan.allowedActions.includes("IMPLEMENT_REUSABLE_SUPPORT")) &&
    !packet.courses.every(course => course.terminalProofDurable &&
      (course.result === "RESTORED" || course.result === "FINAL_DISPOSITION"));
}
