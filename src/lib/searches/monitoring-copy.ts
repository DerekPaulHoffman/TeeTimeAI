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
  firstTimeLookup?: boolean;
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
  const firstTimeLookups = unconfirmed.filter((course) => course.firstTimeLookup);
  const otherUnconfirmed = unconfirmed.filter((course) => !course.firstTimeLookup);
  if (manualOnly.length === 0 && unconfirmed.length === 0 && unavailable.length === 0) {
    return "You're all set. We'll email you the moment a matching tee time opens up.";
  }

  const details: string[] = [];
  if (firstTimeLookups.length > 0) {
    details.push(
      `We haven't checked ${formatCourseNames(firstTimeLookups)} before. We'll email whether alerts are available after the first check, usually within 10 minutes.`
    );
  }
  if (otherUnconfirmed.length > 0) {
    details.push(
      `We'll email whether alerts are available for ${formatCourseNames(otherUnconfirmed)} after the first check, usually within 10 minutes.`
    );
  }
  if (unavailable.length > 0) {
    details.push(
      `Tee-time alerts are currently unavailable for ${formatCourseNames(unavailable)}. Use the official site while Tee Time Spot works to restore checks.`
    );
  }
  if (manualOnly.length > 0) {
    const statuses = manualOnly
      .map((course) =>
        getAlertSupportSavedStatus(course.name, course.alertSupport)
      )
      .join("; ");
    const reference = manualOnly.length === 1 ? "this course" : "these courses";
    details.push(`${statuses}. Tee Time Spot won't send automatic alerts for ${reference}.`);
  }

  return `Alert saved. We'll check courses where alerts are available and email you when a match opens. ${details.join(" ")}`;
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
