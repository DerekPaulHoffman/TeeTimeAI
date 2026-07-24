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
] as const;

export type LocalReaderCourseKey = (typeof LOCAL_READER_COURSE_KEYS)[number];

type LocalReaderCourse = {
  courseName: string;
  bookingUrl: string;
  cardTextIncludes: readonly string[];
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
} as const satisfies Record<LocalReaderCourseKey, LocalReaderCourse>;

export function getLocalReaderCourseKey(
  bookingUrl: string | null | undefined,
): LocalReaderCourseKey | null {
  try {
    const url = new URL(bookingUrl || "");
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      !/^\/(?:onlineresweb(?:\/search-teetime)?\/?)?$/u.test(url.pathname)
    ) {
      return null;
    }
    return (
      LOCAL_READER_COURSE_KEYS.find(
        (courseKey) =>
          new URL(LOCAL_READER_COURSES[courseKey].bookingUrl).hostname ===
          url.hostname,
      ) ?? null
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
    const expected = new URL(LOCAL_READER_COURSES[courseKey].bookingUrl);
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === expected.hostname &&
      /^\/onlineresweb\/search-teetime\/?$/u.test(url.pathname) &&
      url.username === "" &&
      url.password === ""
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
  };
}
