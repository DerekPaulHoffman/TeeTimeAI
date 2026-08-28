export const LOCAL_READER_COURSE_KEYS = [
  "frear-park",
  "simsbury-farms"
] as const;

export type StaticLocalReaderCourseKey = (typeof LOCAL_READER_COURSE_KEYS)[number];
export type DynamicCpsCourseKey = `cps:${string}.cps.golf`;
export type DynamicChronogolfCourseKey = `chronogolf:${string}`;
export type DynamicTenForeCourseKey = `tenfore:${string}`;
export type DynamicEzLinksCourseKey = `ezlinks:${string}.ezlinksgolf.com`;
export type DynamicWebTracCourseKey = `webtrac:${string}.myvscloud.com`;
export type DynamicMemberSportsCourseKey = `membersports:${string}:${string}`;
export type LocalReaderCourseKey =
  | StaticLocalReaderCourseKey
  | DynamicCpsCourseKey
  | DynamicChronogolfCourseKey
  | DynamicTenForeCourseKey
  | DynamicEzLinksCourseKey
  | DynamicWebTracCourseKey
  | DynamicMemberSportsCourseKey;

export type LocalReaderCourse = {
  courseName: string;
  bookingUrl: string;
  cardTextIncludes: readonly string[];
  provider:
    | "CPS"
    | "CHRONOGOLF"
    | "TENFORE"
    | "EZLINKS"
    | "WEBTRAC"
    | "MEMBERSPORTS"
    | "PROPHET";
  prophetCourseIds?: string;
};

const CPS_TENANT_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cps\.golf$/u;
const CPS_SEARCH_PATH = /^\/onlineresweb\/search-teetime\/?$/u;
const CPS_DISCOVERY_PATH = /^\/(?:onlineresweb(?:\/search-teetime)?\/?)?$/u;
const TENFORE_TENANT_PATH = /^\/([a-z0-9][a-z0-9-]{0,127})\/?$/u;
const EZLINKS_TENANT_HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ezlinksgolf\.com$/u;
const WEBTRAC_TENANT_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myvscloud\.com$/u;
const WEBTRAC_SEARCH_PATH = /^\/webtrac\/web\/search\.html\/?$/u;
const MEMBERSPORTS_TEE_TIME_PATH =
  /^\/tee-times\/([1-9]\d{0,9})\/([1-9]\d{0,9})\/(0|[1-9]\d{0,9})(?:\/(0|[1-9]\d{0,9})\/(0|[1-9]\d{0,9}))?\/?$/u;
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
  "frear-park": {
    courseName: "Frear Park Municipal Golf Course",
    bookingUrl: "https://secure.east.prophetservices.com/FrearParkV3/Home/NIndex",
    cardTextIncludes: [],
    provider: "PROPHET",
    prophetCourseIds: "1,2"
  },
  "simsbury-farms": {
    courseName: "Simsbury Farms Golf Course",
    bookingUrl: "https://secure.east.prophetservices.com/SimsburyFarmsV3/Home/NIndex",
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
    if (WEBTRAC_TENANT_HOSTNAME.test(hostname) && isWebTracSearchLanding(url)) {
      return `webtrac:${hostname}` as DynamicWebTracCourseKey;
    }
    const memberSportsScope = getMemberSportsScope(url);
    if (memberSportsScope) {
      return `membersports:${memberSportsScope.clubId}:${memberSportsScope.courseId}`;
    }
    const tenForeTenant = getTenForeTenant(url);
    if (tenForeTenant) {
      return `tenfore:${tenForeTenant}` as DynamicTenForeCourseKey;
    }
    const chronogolfSlug = getChronogolfSlug(url);
    if (chronogolfSlug) {
      return `chronogolf:${chronogolfSlug}` as DynamicChronogolfCourseKey;
    }
    const staticCourseKey =
      LOCAL_READER_COURSE_KEYS.find((courseKey) => {
        const course = LOCAL_READER_COURSES[courseKey];
        const expected = new URL(course.bookingUrl);
        return (
          url.hostname === expected.hostname &&
          isAllowedLocalReaderUrl(courseKey, url.toString())
        );
      }) ?? null;
    return staticCourseKey;
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
      (WEBTRAC_TENANT_HOSTNAME.test(url.hostname) &&
        WEBTRAC_SEARCH_PATH.test(url.pathname) &&
        isWebTracSearchLanding(url))
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
    if (isDynamicWebTracCourseKey(courseKey)) {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === courseKey.slice("webtrac:".length) &&
        WEBTRAC_TENANT_HOSTNAME.test(url.hostname) &&
        WEBTRAC_SEARCH_PATH.test(url.pathname) &&
        isWebTracSearchLanding(url) &&
        url.username === "" &&
        url.password === "" &&
        url.hash === ""
      );
    }
    if (isDynamicMemberSportsCourseKey(courseKey)) {
      const url = new URL(value);
      const scope = getMemberSportsScope(url);
      return Boolean(
        scope && courseKey === `membersports:${scope.clubId}:${scope.courseId}`
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
      course.provider === "PROPHET" &&
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
  } catch {
    return false;
  }
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
  if (isDynamicWebTracCourseKey(courseKey)) {
    const [year, month, day] = targetDate.split("-");
    const url = new URL(`https://${courseKey.slice("webtrac:".length)}/webtrac/web/search.html`);
    url.searchParams.set("Action", "Start");
    url.searchParams.set("begindate", `${month}/${day}/${year}`);
    url.searchParams.set("begintime", "12:00 am");
    url.searchParams.set("display", "Detail");
    url.searchParams.set("grwebsearch_buttonsearch", "yes");
    url.searchParams.set("module", "GR");
    url.searchParams.set("numberofplayers", String(Math.max(1, Math.min(4, players))));
    url.searchParams.set("page", "1");
    url.searchParams.set("search", "yes");
    return url.toString();
  }
  if (isDynamicMemberSportsCourseKey(courseKey)) {
    const [, clubId, courseId] = courseKey.split(":");
    return `https://app.membersports.com/tee-times/${clubId}/${courseId}/0/8/0`;
  }
  const course = LOCAL_READER_COURSES[courseKey];
  return `${course.bookingUrl}?CourseId=${course.prophetCourseIds}&Date=${targetDate}&Time=AnyTime&Player=${players}&Hole=18`;
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

export function isDynamicWebTracCourseKey(value: string): value is DynamicWebTracCourseKey {
  return (
    value.startsWith("webtrac:") && WEBTRAC_TENANT_HOSTNAME.test(value.slice("webtrac:".length))
  );
}

export function isDynamicMemberSportsCourseKey(
  value: string
): value is DynamicMemberSportsCourseKey {
  return /^membersports:[1-9]\d{0,9}:[1-9]\d{0,9}$/u.test(value);
}

export function getLocalReaderCourse(
  courseKey: LocalReaderCourseKey,
  courseName?: string
): LocalReaderCourse | null {
  if (
    isDynamicCpsCourseKey(courseKey) ||
    isDynamicChronogolfCourseKey(courseKey) ||
    isDynamicTenForeCourseKey(courseKey) ||
    isDynamicEzLinksCourseKey(courseKey) ||
    isDynamicWebTracCourseKey(courseKey) ||
    isDynamicMemberSportsCourseKey(courseKey)
  ) {
    const normalizedCourseName = courseName?.trim();
    if (!normalizedCourseName) return null;
    return {
      courseName: normalizedCourseName,
      bookingUrl: isDynamicWebTracCourseKey(courseKey)
        ? `https://${courseKey.slice("webtrac:".length)}/webtrac/web/search.html?module=GR`
        : getLocalReaderJobUrl(courseKey, ""),
      cardTextIncludes: [],
      provider: isDynamicCpsCourseKey(courseKey)
        ? "CPS"
        : isDynamicChronogolfCourseKey(courseKey)
          ? "CHRONOGOLF"
          : isDynamicTenForeCourseKey(courseKey)
            ? "TENFORE"
            : isDynamicEzLinksCourseKey(courseKey)
              ? "EZLINKS"
              : isDynamicWebTracCourseKey(courseKey)
                ? "WEBTRAC"
                : "MEMBERSPORTS"
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
  const allowedSearchParams = new Set([
    "coursesIds",
    "date",
    "deals",
    "groupSize",
    "holes",
    "step"
  ]);
  if (
    url.hostname !== "www.chronogolf.com" ||
    url.hash !== "" ||
    !Array.from(url.searchParams.keys()).every((key) => allowedSearchParams.has(key))
  ) {
    return null;
  }
  const date = url.searchParams.get("date");
  const step = url.searchParams.get("step");
  const groupSize = url.searchParams.get("groupSize");
  const deals = url.searchParams.get("deals");
  if (date && !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null;
  if (step && step !== "teetimes") return null;
  if (groupSize && !/^[0-4]$/u.test(groupSize)) return null;
  if (deals && deals !== "false") return null;
  return /^\/club\/([a-z0-9][a-z0-9-]{0,127})\/?$/u.exec(url.pathname)?.[1] ?? null;
}

function getMemberSportsScope(url: URL) {
  if (
    url.protocol !== "https:" ||
    url.hostname !== "app.membersports.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }
  const match = MEMBERSPORTS_TEE_TIME_PATH.exec(url.pathname);
  if (!match) return null;
  const values = match.slice(1).filter((value): value is string => value !== undefined);
  if (values.some((value) => Number(value) > 2_147_483_647)) return null;
  return { clubId: match[1], courseId: match[2] };
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
    (url.hash === "" || url.hash === "#/search" || url.hash === "#!/search")
  );
}

function isWebTracSearchLanding(url: URL) {
  if (!WEBTRAC_SEARCH_PATH.test(url.pathname) || url.hash !== "") return false;
  if (url.searchParams.size === 0) return true;

  const normalizedEntries = [...url.searchParams.entries()].map(
    ([key, value]) => [key.toLowerCase(), value] as const
  );
  const keys = new Set(normalizedEntries.map(([key]) => key));
  if (keys.size !== normalizedEntries.length) return false;
  if (keys.size === 1) {
    return keys.has("module") && url.searchParams.get("module")?.toUpperCase() === "GR";
  }

  const requiredKeys = new Set([
    "action",
    "begindate",
    "begintime",
    "display",
    "grwebsearch_buttonsearch",
    "module",
    "numberofplayers",
    "page",
    "search"
  ]);
  if (keys.size !== requiredKeys.size || ![...requiredKeys].every((key) => keys.has(key))) {
    return false;
  }
  const values = new Map(normalizedEntries);
  return (
    values.get("action")?.toLowerCase() === "start" &&
    /^\d{2}\/\d{2}\/\d{4}$/u.test(values.get("begindate") || "") &&
    /^\d{1,2}:\d{2}\s*(?:am|pm)$/iu.test(values.get("begintime") || "") &&
    values.get("display")?.toLowerCase() === "detail" &&
    values.get("grwebsearch_buttonsearch")?.toLowerCase() === "yes" &&
    values.get("module")?.toUpperCase() === "GR" &&
    /^[1-4]$/u.test(values.get("numberofplayers") || "") &&
    values.get("page") === "1" &&
    values.get("search")?.toLowerCase() === "yes"
  );
}
