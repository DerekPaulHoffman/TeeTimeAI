type MonitoringCourse = {
  name: string;
  alertSupport?: "OFFICIAL_SITE_ONLY";
};

export function buildSearchSavedMessage(courses: MonitoringCourse[]) {
  const officialSiteOnly = courses.filter(
    (course) => course.alertSupport === "OFFICIAL_SITE_ONLY"
  );
  if (officialSiteOnly.length === 0) {
    return "You're all set. We'll email you the moment a matching tee time opens up.";
  }

  const names = formatCourseNames(officialSiteOnly.map((course) => course.name));
  const verb = officialSiteOnly.length === 1 ? "is" : "are";
  return `Alert saved. We'll monitor supported courses and email you when a match opens. ${names} ${verb} official-site only and won't be checked automatically.`;
}

function formatCourseNames(names: string[]) {
  if (names.length <= 1) {
    return names[0] ?? "The selected course";
  }
  if (names.length === 2) {
    return names.join(" and ");
  }
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}
