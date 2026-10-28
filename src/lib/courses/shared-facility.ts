import type { CourseCandidate } from "@/lib/places/google";

export function courseSelectionKey(course: Pick<CourseCandidate, "courseId" | "googlePlaceId">) {
  return course.courseId ?? course.googlePlaceId;
}

export function getFacilityCourses(course: CourseCandidate): CourseCandidate[] {
  return course.facilityCourses?.length ? course.facilityCourses : [course];
}
