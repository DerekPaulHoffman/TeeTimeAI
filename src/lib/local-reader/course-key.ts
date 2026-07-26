export const LOCAL_READER_COURSE_KEYS = [
  "grassy-hill",
  "overpeck",
  "glen-mills",
  "bayberry-hills",
  "oak-lane",
  "candia-woods",
  "oxford-greens",
  "shennecossett",
  "stanley",
  "colonie",
  "springfield-township",
  "pine-hollow",
  "capital-hills",
  "crestbrook",
  "crystal-lake",
  "chanticlair",
] as const;

export type LocalReaderCourseKey = (typeof LOCAL_READER_COURSE_KEYS)[number];

type LocalReaderCourse = {
  courseName: string;
  bookingUrl: string;
  cardTextIncludes: readonly string[];
  provider: "CPS" | "CHRONOGOLF";
};

export const LOCAL_READER_COURSES = {
  "grassy-hill": course("Grassy Hill Country Club", "grassyhill.cps.golf"),
  overpeck: course("Overpeck Golf Course", "overpeckgc.cps.golf"),
  "glen-mills": course(
    "The Golf Course at Glen Mills",
    "golfatglenmills.cps.golf",
  ),
  "bayberry-hills": course(
    "Bayberry Hills Golf Course",
    "yarmouthpublic.cps.golf",
  ),
  "oak-lane": course(
    "The Tradition Golf Club at Oak Lane",
    "traditionoaklane.cps.golf",
  ),
  "candia-woods": course("Candia Woods Golf Links", "candiawoods.cps.golf"),
  "oxford-greens": course(
    "The Golf Club at Oxford Greens",
    "oxfordgreens.cps.golf",
  ),
  shennecossett: course("Shennecossett Golf Course", "shennecossett.cps.golf"),
  stanley: course("Stanley Golf Course SGC", "stanleygolf.cps.golf"),
  colonie: course("Colonie Golf Course", "colonie.cps.golf"),
  "springfield-township": course(
    "Springfield Twp Golf Course",
    "springfield.cps.golf",
  ),
  "pine-hollow": course("Pine Hollow Golf Club", "pinehollow.cps.golf"),
  "capital-hills": course("Capital Hills at Albany", "capitalhillsny.cps.golf"),
  crestbrook: chronogolfCourse(
    "Crestbrook Golf Course",
    "crestbrook-park-golf-course",
  ),
  "crystal-lake": chronogolfCourse(
    "crystal lake golf",
    "crystal-lake-golf-club-rhode-island-mapleville",
  ),
  chanticlair: chronogolfCourse(
    "Chanticlair Golf Course",
    "chanticlair-golf-club",
  ),
} as const satisfies Record<LocalReaderCourseKey, LocalReaderCourse>;

export function getLocalReaderCourseKey(
  bookingUrl: string | null | undefined,
): LocalReaderCourseKey | null {
  try {
    const url = new URL(bookingUrl || "");
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return (
      LOCAL_READER_COURSE_KEYS.find((courseKey) => {
        const course = LOCAL_READER_COURSES[courseKey];
        const expected = new URL(course.bookingUrl);
        if (course.provider === "CHRONOGOLF") {
          return isAllowedLocalReaderUrl(courseKey, url.toString());
        }
        return (
          url.hostname === expected.hostname &&
          /^\/(?:onlineresweb(?:\/search-teetime)?\/?)?$/u.test(url.pathname)
        );
      }) ?? null
    );
  } catch {
    return null;
  }
}

export function isAllowedLocalReaderUrl(
  courseKey: LocalReaderCourseKey,
  value: string,
) {
  try {
    const course = LOCAL_READER_COURSES[courseKey];
    const expected = new URL(course.bookingUrl);
    const url = new URL(value);
    const commonSafeUrl =
      url.protocol === "https:" &&
      url.hostname === expected.hostname &&
      url.username === "" &&
      url.password === "";
    if (!commonSafeUrl || url.pathname !== expected.pathname) return false;
    if (course.provider === "CPS") {
      return /^\/onlineresweb\/search-teetime\/?$/u.test(url.pathname);
    }
    const allowedSearchParams = new Set([
      "coursesIds",
      "date",
      "deals",
      "groupSize",
      "holes",
      "step",
    ]);
    if (
      !Array.from(url.searchParams.keys()).every((key) =>
        allowedSearchParams.has(key),
      )
    ) {
      return false;
    }
    const date = url.searchParams.get("date");
    const step = url.searchParams.get("step");
    const groupSize = url.searchParams.get("groupSize");
    const deals = url.searchParams.get("deals");
    return (
      (!date || /^\d{4}-\d{2}-\d{2}$/u.test(date)) &&
      (!step || step === "teetimes") &&
      (!groupSize || /^[0-4]$/u.test(groupSize)) &&
      (!deals || deals === "false")
    );
  } catch {
    return false;
  }
}

function course(
  courseName: string,
  hostname: string,
  cardTextIncludes: readonly string[] = [],
): LocalReaderCourse {
  return {
    courseName,
    bookingUrl: `https://${hostname}/onlineresweb/search-teetime`,
    cardTextIncludes,
    provider: "CPS",
  };
}

function chronogolfCourse(courseName: string, slug: string): LocalReaderCourse {
  return {
    courseName,
    bookingUrl: `https://www.chronogolf.com/club/${slug}`,
    cardTextIncludes: [],
    provider: "CHRONOGOLF",
  };
}

export function getLocalReaderJobUrl(
  courseKey: LocalReaderCourseKey,
  targetDate: string,
) {
  const course = LOCAL_READER_COURSES[courseKey];
  if (course.provider === "CPS") return course.bookingUrl;
  const url = new URL(course.bookingUrl);
  url.searchParams.set("date", targetDate);
  url.searchParams.set("step", "teetimes");
  return url.toString();
}
