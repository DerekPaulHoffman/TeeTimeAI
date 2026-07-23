import {
  getAlertSupportSavedStatus,
  isManualOnlyAlertSupport,
  type CourseAlertSupport,
  type CourseMonitoringSupport
} from "@/lib/courses/intelligence";

type MonitoringCourse = {
  name: string;
  alertSupport?: CourseAlertSupport;
  monitoringSupport?: CourseMonitoringSupport;
  monitoringReadiness?:
    | "READY"
    | "VERIFYING"
    | "UNAVAILABLE"
    | "TEMPORARILY_UNAVAILABLE";
};

export function buildSearchSavedMessage(courses: MonitoringCourse[]) {
  const manualOnly = courses.filter(
    (course): course is MonitoringCourse & { alertSupport: CourseAlertSupport } =>
      isManualOnlyAlertSupport(course.alertSupport)
  );
  const unconfirmed = courses.filter(
    (course) =>
      !isManualOnlyAlertSupport(course.alertSupport) &&
      course.monitoringReadiness !== "UNAVAILABLE" &&
      course.monitoringReadiness !== "TEMPORARILY_UNAVAILABLE" &&
      course.monitoringSupport !== "AUTOMATIC"
  );
  const unavailable = courses.filter(
    (course) =>
      !isManualOnlyAlertSupport(course.alertSupport) &&
      (course.monitoringReadiness === "UNAVAILABLE" ||
        course.monitoringReadiness === "TEMPORARILY_UNAVAILABLE")
  );
  if (manualOnly.length === 0 && unconfirmed.length === 0 && unavailable.length === 0) {
    return "You're all set. We'll email you the moment a matching tee time opens up.";
  }

  const details: string[] = [];
  if (unconfirmed.length > 0) {
    details.push(
      `We'll email a monitoring verdict for ${formatCourseNames(unconfirmed)} after the first check; new-course verification is capped at 30 minutes.`
    );
  }
  if (unavailable.length > 0) {
    details.push(
      `Automatic monitoring is currently unavailable for ${formatCourseNames(unavailable)}. Use the official site while Tee Time Spot continues checking coverage in the background.`
    );
  }
  if (manualOnly.length > 0) {
    const statuses = manualOnly
      .map((course) =>
        getAlertSupportSavedStatus(course.name, course.alertSupport)
      )
      .join("; ");
    const pronoun = manualOnly.length === 1 ? "It" : "They";
    details.push(`${statuses}. ${pronoun} won't be checked automatically.`);
  }

  return `Alert saved. We'll monitor supported courses and email you when a match opens. ${details.join(" ")}`;
}

function formatCourseNames(courses: MonitoringCourse[]) {
  if (courses.length === 1) {
    return courses[0].name;
  }

  if (courses.length === 2) {
    return `${courses[0].name} and ${courses[1].name}`;
  }

  return `${courses.slice(0, -1).map((course) => course.name).join(", ")}, and ${courses.at(-1)?.name}`;
}
