import {
  getAlertSupportLabel,
  isManualOnlyAlertSupport,
  type CourseAlertSupport
} from "@/lib/courses/intelligence";

type MonitoringCourse = {
  name: string;
  alertSupport?: CourseAlertSupport;
};

export function buildSearchSavedMessage(courses: MonitoringCourse[]) {
  const manualOnly = courses.filter(
    (course): course is MonitoringCourse & { alertSupport: CourseAlertSupport } =>
      isManualOnlyAlertSupport(course.alertSupport)
  );
  if (manualOnly.length === 0) {
    return "You're all set. We'll email you the moment a matching tee time opens up.";
  }

  const statuses = manualOnly
    .map((course) => `${course.name} is ${getAlertSupportLabel(course.alertSupport).toLowerCase()}`)
    .join("; ");
  const pronoun = manualOnly.length === 1 ? "It" : "They";
  return `Alert saved. We'll monitor supported courses and email you when a match opens. ${statuses}. ${pronoun} won't be checked automatically.`;
}
