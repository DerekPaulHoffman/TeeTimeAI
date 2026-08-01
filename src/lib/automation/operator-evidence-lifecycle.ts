export const OPERATOR_COURSE_EVIDENCE_REVIEW_MS = 30 * 24 * 60 * 60 * 1000;

export function getOperatorCourseEvidenceReviewAt(observedAt: Date) {
  return new Date(observedAt.getTime() + OPERATOR_COURSE_EVIDENCE_REVIEW_MS);
}
