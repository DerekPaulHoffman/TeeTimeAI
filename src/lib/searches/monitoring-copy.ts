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
};

export function buildSearchSavedMessage(courses: MonitoringCourse[]) {
  const manualOnly = courses.filter(
    (course): course is MonitoringCourse & { alertSupport: CourseAlertSupport } =>
      isManualOnlyAlertSupport(course.alertSupport)
  );
  const unconfirmed = courses.filter(
    (course) =>
      !isManualOnlyAlertSupport(course.alertSupport) &&
      course.monitoringSupport !== "AUTOMATIC"
  );
  if (manualOnly.length === 0 && unconfirmed.length === 0) {
    return "You're all set. We'll email you the moment a matching tee time opens up.";
  }

  const details: string[] = [];
  if (unconfirmed.length > 0) {
    details.push(
      `We'll verify automatic monitoring for ${formatCourseNames(unconfirmed)} as your alert starts.`
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
