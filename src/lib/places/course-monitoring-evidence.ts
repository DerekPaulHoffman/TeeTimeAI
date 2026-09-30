import type { CourseCandidate } from "@/lib/places/google";

export function hasReadyAutomaticMonitoring(
  course: Pick<CourseCandidate, "monitoringSupport" | "monitoringReadiness">,
) {
  return course.monitoringSupport === "AUTOMATIC" &&
    course.monitoringReadiness === "READY";
}

// Runtime caches and restored candidates are discovery inputs, not current
// monitoring evidence. Rebuild these fields from the canonical course row.
export function clearCourseMonitoringEvidence(course: CourseCandidate): CourseCandidate {
  const candidate = { ...course };
  delete candidate.alertSupport;
  delete candidate.monitoringSupport;
  delete candidate.monitoringReadiness;
  delete candidate.monitoringReadinessObservedAt;
  delete candidate.firstTimeLookup;
  delete candidate.profileUrl;
  return candidate;
}
