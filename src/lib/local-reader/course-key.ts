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
  "lyman-orchards",
  "hyde-park",
  "frear-park",
  "simsbury-farms"
] as const;

export type StaticLocalReaderCourseKey = (typeof LOCAL_READER_COURSE_KEYS)[number];
export type DynamicCpsCourseKey = `cps:${string}.cps.golf`;
export type DynamicChronogolfCourseKey = `chronogolf:${string}`;
export type DynamicTenForeCourseKey = `tenfore:${string}`;
export type DynamicEzLinksCourseKey = `ezlinks:${string}.ezlinksgolf.com`;
export type LocalReaderCourseKey =
  | StaticLocalReaderCourseKey
  | DynamicCpsCourseKey
  | DynamicChronogolfCourseKey
  | DynamicTenForeCourseKey
  | DynamicEzLinksCourseKey;

export type LocalReaderCourse = {
  courseName: string;
  bookingUrl: string;
  cardTextIncludes: readonly string[];
  provider: "CPS" | "CHRONOGOLF" | "TENFORE" | "EZLINKS" | "PROPHET";
  prophetCourseIds?: string;
};

const CPS_TENANT_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cps\.golf$/u;
const CPS_SEARCH_PATH = /^\/onlineresweb\/search-teetime\/?$/u;
const CPS_DISCOVERY_PATH = /^\/(?:onlineresweb(?:\/search-teetime)?\/?)?$/u;
const TENFORE_TENANT_PATH = /^\/([a-z0-9][a-z0-9-]{0,127})\/?$/u;
const EZLINKS_TENANT_HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ezlinksgolf\.com$/u;
const EZLINKS_BLOCKED_TENANT_LABELS = new Set([
  "admin",
  "api",
  "auth",
  "blog",
  "careers",
  "config",
  "contact",
  "corporate",
  "dev",
  "help",
  "marketing",
  "shop",
  "store",
  "support"
]);

export const LOCAL_READER_COURSES = {
  "grassy-hill": course("Grassy Hill Country Club", "grassyhill.cps.golf"),
  overpeck: course("Overpeck Golf Course", "overpeckgc.cps.golf"),
  "glen-mills": course("The Golf Course at Glen Mills", "golfatglenmills.cps.golf"),
  "bayberry-hills": course("Bayberry Hills Golf Course", "yarmouthpublic.cps.golf"),
  "oak-lane": course("The Tradition Golf Club at Oak Lane", "traditionoaklane.cps.golf"),
  "candia-woods": course("Candia Woods Golf Links", "candiawoods.cps.golf"),
  "oxford-greens": course("The Golf Club at Oxford Greens", "oxfordgreens.cps.golf"),
  shennecossett: course("Shennecossett Golf Course", "shennecossett.cps.golf"),
  stanley: course("Stanley Golf Course SGC", "stanleygolf.cps.golf"),
  colonie: course("Colonie Golf Course", "colonie.cps.golf"),
  "springfield-township": course("Springfield Twp Golf Course", "springfield.cps.golf"),
  "pine-hollow": course("Pine Hollow Golf Club", "pinehollow.cps.golf"),
  "capital-hills": course("Capital Hills at Albany", "capitalhillsny.cps.golf"),
  crestbrook: chronogolfCourse("Crestbrook Golf Course", "crestbrook-park-golf-course"),
  "crystal-lake": chronogolfCourse(
    "crystal lake golf",
    "crystal-lake-golf-club-rhode-island-mapleville"
  ),
  chanticlair: chronogolfCourse("Chanticlair Golf Course", "chanticlair-golf-club"),
  "lyman-orchards": chronogolfCourse("Lyman Orchards Golf Club", "lyman-orchards-golf-club"),
  "hyde-park": chronogolfCourse("Hyde Park Golf Club", "hyde-park-golf-club"),
  "frear-park": {
    courseName: "Frear Park Municipal Golf Course",
    bookingUrl: "https://secure.east.prophetservices.com/FrearParkV3/Home/NIndex",
    cardTextIncludes: [],
    provider: "PROPHET",
    prophetCourseIds: "1,2"
  },
  "simsbury-farms": {
    courseName: "Simsbury Farms Golf Course",
    bookingUrl: "https://secure.east.prophetservices.com/SimsburyFarmsV3",
    cardTextIncludes: [],
    provider: "PROPHET",
    prophetCourseIds: "1"
  }
} as const satisfies Record<StaticLocalReaderCourseKey, LocalReaderCourse>;

export function getLocalReaderCourseKey(
  bookingUrl: string | null | undefined
): LocalReaderCourseKey | null {
  try {
    const url = new URL(bookingUrl || "");
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      return null;
    }
    const hostname = url.hostname.toLowerCase();
    if (CPS_TENANT_HOSTNAME.test(hostname) && CPS_DISCOVERY_PATH.test(url.pathname)) {
      return `cps:${hostname}` as DynamicCpsCourseKey;
    }
    if (isSafeEzLinksTenantHostname(hostname) && isEzLinksSearchLanding(url)) {
      return `ezlinks:${hostname}` as DynamicEzLinksCourseKey;
    }
    const tenForeTenant = getTenForeTenant(url);
    if (tenForeTenant) {
      return `tenfore:${tenForeTenant}` as DynamicTenForeCourseKey;
    }
    const staticCourseKey =
      LOCAL_READER_COURSE_KEYS.find((courseKey) => {
        const course = LOCAL_READER_COURSES[courseKey];
        const expected = new URL(course.bookingUrl);
        return (
          course.provider !== "CPS" &&
          url.hostname === expected.hostname &&
          isAllowedLocalReaderUrl(courseKey, url.toString())
        );
      }) ?? null;
    if (staticCourseKey) return staticCourseKey;
    const chronogolfSlug = getChronogolfSlug(url);
    return chronogolfSlug ? (`chronogolf:${chronogolfSlug}` as DynamicChronogolfCourseKey) : null;
  } catch {
    return null;
  }
}

export function isLocalReaderCandidateUrl(bookingUrl: string | null | undefined) {
  try {
    const url = new URL(bookingUrl || "");
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      return false;
    }
    return (
      (url.hostname === "secure.east.prophetservices.com" &&
        url.pathname.startsWith("/FrearParkV3")) ||
      (url.hostname === "www.simsburyfarms.com" && url.pathname === "/book-a-tee-time") ||
      (url.hostname === "ctguilfordweb.myvscloud.com" &&
        url.pathname === "/webtrac/web/search.html")
    );
  } catch {
    return false;
  }
}

export function isAllowedLocalReaderUrl(courseKey: LocalReaderCourseKey, value: string) {
  try {
    if (isDynamicCpsCourseKey(courseKey)) {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === courseKey.slice("cps:".length) &&
        CPS_TENANT_HOSTNAME.test(url.hostname) &&
        CPS_SEARCH_PATH.test(url.pathname) &&
        url.username === "" &&
        url.password === ""
      );
    }
    if (isDynamicTenForeCourseKey(courseKey)) {
      const url = new URL(value);
      const date = url.searchParams.get("date");
      return (
        url.protocol === "https:" &&
        url.hostname === "fox.tenfore.golf" &&
        getTenForeTenant(url) === courseKey.slice("tenfore:".length) &&
        url.username === "" &&
        url.password === "" &&
        url.hash === "" &&
        Array.from(url.searchParams.keys()).every((key) => key === "date") &&
        (!date || /^\d{4}-\d{2}-\d{2}$/u.test(date))
      );
    }
    if (isDynamicChronogolfCourseKey(courseKey)) {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "www.chronogolf.com" &&
        getChronogolfSlug(url) === courseKey.slice("chronogolf:".length) &&
        url.username === "" &&
        url.password === ""
      );
    }
    if (isDynamicEzLinksCourseKey(courseKey)) {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === courseKey.slice("ezlinks:".length) &&
        isSafeEzLinksTenantHostname(url.hostname) &&
        isEzLinksSearchLanding(url) &&
        url.username === "" &&
        url.password === ""
      );
    }
    const course = LOCAL_READER_COURSES[courseKey];
    const expected = new URL(course.bookingUrl);
    const url = new URL(value);
    const commonSafeUrl =
      url.protocol === "https:" &&
      url.hostname === expected.hostname &&
      url.username === "" &&
      url.password === "";
    if (!commonSafeUrl) return false;
    if (course.provider === "PROPHET") {
      const tenantRoot = expected.pathname.replace(/\/Home\/NIndex\/?$/iu, "");
      const safePath =
        url.pathname === expected.pathname ||
        url.pathname === tenantRoot ||
        url.pathname === `${tenantRoot}/`;
      const allowedKeys = new Set(["CourseId", "Date", "Time", "Player", "Hole"]);
      const date = url.searchParams.get("Date");
      const player = url.searchParams.get("Player");
      const hasNoQuery = url.searchParams.size === 0;
      const hasExactJobQuery =
        url.searchParams.size === allowedKeys.size &&
        Array.from(allowedKeys).every((key) => url.searchParams.has(key));
      return (
        safePath &&
        Array.from(url.searchParams.keys()).every((key) => allowedKeys.has(key)) &&
        (hasNoQuery ||
          (hasExactJobQuery &&
            /^\d{4}-\d{2}-\d{2}$/u.test(date || "") &&
            /^[1-4]$/u.test(player || "") &&
            url.searchParams.get("CourseId") === course.prophetCourseIds &&
            url.searchParams.get("Time") === "AnyTime" &&
            url.searchParams.get("Hole") === "18")) &&
        url.hash === ""
      );
    }
    if (url.pathname !== expected.pathname) return false;
    if (course.provider === "CPS") {
      return /^\/onlineresweb\/search-teetime\/?$/u.test(url.pathname);
    }
    const allowedSearchParams = new Set([
      "coursesIds",
      "date",
      "deals",
      "groupSize",
      "holes",
      "step"
    ]);
    if (!Array.from(url.searchParams.keys()).every((key) => allowedSearchParams.has(key))) {
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
  cardTextIncludes: readonly string[] = []
): LocalReaderCourse {
  return {
    courseName,
    bookingUrl: `https://${hostname}/onlineresweb/search-teetime`,
    cardTextIncludes,
    provider: "CPS"
  };
}

function chronogolfCourse(courseName: string, slug: string): LocalReaderCourse {
  return {
    courseName,
    bookingUrl: `https://www.chronogolf.com/club/${slug}`,
    cardTextIncludes: [],
    provider: "CHRONOGOLF"
  };
}

export function getLocalReaderJobUrl(
  courseKey: LocalReaderCourseKey,
  targetDate: string,
  players = 1
) {
  if (isDynamicCpsCourseKey(courseKey)) {
    return `https://${courseKey.slice("cps:".length)}/onlineresweb/search-teetime`;
  }
  if (isDynamicTenForeCourseKey(courseKey)) {
    const url = new URL(`https://fox.tenfore.golf/${courseKey.slice("tenfore:".length)}`);
    if (targetDate) url.searchParams.set("date", targetDate);
    return url.toString();
  }
  if (isDynamicChronogolfCourseKey(courseKey)) {
    const url = new URL(`https://www.chronogolf.com/club/${courseKey.slice("chronogolf:".length)}`);
    url.searchParams.set("date", targetDate);
    url.searchParams.set("step", "teetimes");
    return url.toString();
  }
  if (isDynamicEzLinksCourseKey(courseKey)) {
    return `https://${courseKey.slice("ezlinks:".length)}/index.html#!/search`;
  }
  const course = LOCAL_READER_COURSES[courseKey];
  if (course.provider === "CPS") return course.bookingUrl;
  if (course.provider === "PROPHET") {
    return `${course.bookingUrl}?CourseId=${course.prophetCourseIds}&Date=${targetDate}&Time=AnyTime&Player=${players}&Hole=18`;
  }
  const url = new URL(course.bookingUrl);
  url.searchParams.set("date", targetDate);
  url.searchParams.set("step", "teetimes");
  return url.toString();
}

export function isDynamicCpsCourseKey(value: string): value is DynamicCpsCourseKey {
  return value.startsWith("cps:") && CPS_TENANT_HOSTNAME.test(value.slice("cps:".length));
}

export function isDynamicTenForeCourseKey(value: string): value is DynamicTenForeCourseKey {
  return (
    value.startsWith("tenfore:") &&
    /^[a-z0-9][a-z0-9-]{0,127}$/u.test(value.slice("tenfore:".length))
  );
}

export function isDynamicChronogolfCourseKey(value: string): value is DynamicChronogolfCourseKey {
  return (
    value.startsWith("chronogolf:") &&
    /^[a-z0-9][a-z0-9-]{0,127}$/u.test(value.slice("chronogolf:".length))
  );
}

export function isDynamicEzLinksCourseKey(value: string): value is DynamicEzLinksCourseKey {
  return (
    value.startsWith("ezlinks:") &&
    isSafeEzLinksTenantHostname(value.slice("ezlinks:".length))
  );
}

export function getLocalReaderCourse(
  courseKey: LocalReaderCourseKey,
  courseName?: string
): LocalReaderCourse | null {
  if (
    isDynamicCpsCourseKey(courseKey) ||
    isDynamicChronogolfCourseKey(courseKey) ||
    isDynamicTenForeCourseKey(courseKey) ||
    isDynamicEzLinksCourseKey(courseKey)
  ) {
    const normalizedCourseName = courseName?.trim();
    if (!normalizedCourseName) return null;
    return {
      courseName: normalizedCourseName,
      bookingUrl: getLocalReaderJobUrl(courseKey, ""),
      cardTextIncludes: [],
      provider: isDynamicCpsCourseKey(courseKey)
        ? "CPS"
        : isDynamicChronogolfCourseKey(courseKey)
          ? "CHRONOGOLF"
          : isDynamicTenForeCourseKey(courseKey)
            ? "TENFORE"
            : "EZLINKS"
    };
  }
  return LOCAL_READER_COURSES[courseKey];
}

function getTenForeTenant(url: URL) {
  if (
    url.hostname !== "fox.tenfore.golf" ||
    url.hash !== "" ||
    !Array.from(url.searchParams.keys()).every((key) => key === "date")
  ) {
    return null;
  }
  const date = url.searchParams.get("date");
  if (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  return TENFORE_TENANT_PATH.exec(url.pathname)?.[1] ?? null;
}

function getChronogolfSlug(url: URL) {
  if (
    url.hostname !== "www.chronogolf.com" ||
    url.hash !== "" ||
    !Array.from(url.searchParams.keys()).every((key) => ["date", "step"].includes(key))
  ) {
    return null;
  }
  const date = url.searchParams.get("date");
  const step = url.searchParams.get("step");
  if (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  if (step && step !== "teetimes") return null;
  return /^\/club\/([a-z0-9][a-z0-9-]{0,127})\/?$/u.exec(url.pathname)?.[1] ?? null;
}

function isSafeEzLinksTenantHostname(hostname: string) {
  if (!EZLINKS_TENANT_HOSTNAME.test(hostname)) return false;
  const tenant = hostname.slice(0, -".ezlinksgolf.com".length);
  return !EZLINKS_BLOCKED_TENANT_LABELS.has(tenant);
}

function isEzLinksSearchLanding(url: URL) {
  if (url.search !== "") return false;
  if (url.pathname === "/") return url.hash === "";
  return (
    url.pathname === "/index.html" &&
    (url.hash === "" || url.hash === "#!/search")
  );
}
