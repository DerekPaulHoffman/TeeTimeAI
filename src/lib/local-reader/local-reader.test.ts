import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  LOCAL_READER_COURSES,
  isAllowedLocalReaderUrl,
  localReaderJobSchema,
  localReaderResultSchema,
  signLocalReaderPayload,
  validateLocalReaderResultForJob,
  verifyLocalReaderSignature,
  type LocalReaderJob
} from "./contracts";
import {
  getLocalReaderJobUrl,
  getLocalReaderCourseKey,
  isLocalReaderCandidateUrl,
  LOCAL_READER_COURSE_KEYS
} from "./course-key";

type Reader = {
  SKIP_DATE_SELECTION?: boolean;
  SKIP_PLAYER_SELECTION?: boolean;
  isExpectedChallengePage?: (job: LocalReaderJob, pageUrl: string) => boolean;
  waitForPassiveChallengeClearance?: (
    documentRoot: Document,
    windowRoot: { setTimeout: (callback: () => void, delay: number) => unknown },
    maxWaitMilliseconds?: number
  ) => Promise<boolean>;
  readSnapshot: (
    documentRoot: Document,
    pageUrl: string,
    job: LocalReaderJob
  ) => {
    status: string;
    slots: Array<Record<string, unknown>>;
  };
};

function jobFor(courseKey: keyof typeof LOCAL_READER_COURSES = "grassy-hill"): LocalReaderJob {
  const course = LOCAL_READER_COURSES[courseKey];
  return {
    id: "job-1",
    courseKey,
    targetDate: "2026-07-25",
    players: 2,
    requestedAt: "2026-07-24T12:00:00.000Z",
    expiresAt: "2026-07-24T12:05:00.000Z",
    courseName: course.courseName,
    bookingUrl: course.bookingUrl,
    cardTextIncludes: [...course.cardTextIncludes]
  };
}

function dynamicCpsJob(hostname = "future-public.cps.golf"): LocalReaderJob {
  return {
    id: "job-future",
    courseKey: `cps:${hostname}`,
    targetDate: "2026-07-25",
    players: 2,
    requestedAt: "2026-07-24T12:00:00.000Z",
    expiresAt: "2026-07-24T12:05:00.000Z",
    courseName: "Future Public Golf Course",
    bookingUrl: `https://${hostname}/onlineresweb/search-teetime`,
    cardTextIncludes: []
  };
}

function dynamicTenForeJob(tenant = "gainfieldfarms"): LocalReaderJob {
  return {
    id: "job-tenfore",
    courseKey: `tenfore:${tenant}`,
    targetDate: "2026-07-29",
    players: 3,
    requestedAt: "2026-07-28T12:00:00.000Z",
    expiresAt: "2026-07-28T12:05:00.000Z",
    courseName: "Gainfield Farms Golf Course",
    bookingUrl: `https://fox.tenfore.golf/${tenant}?date=2026-07-29`,
    cardTextIncludes: []
  };
}

function dynamicEzLinksJob(hostname = "ballysapi.ezlinksgolf.com"): LocalReaderJob {
  return {
    id: "job-ezlinks",
    courseKey: `ezlinks:${hostname}`,
    targetDate: "2026-07-31",
    players: 3,
    requestedAt: "2026-07-31T12:00:00.000Z",
    expiresAt: "2026-07-31T12:05:00.000Z",
    courseName: "Bally's Golf Links at Ferry Point",
    bookingUrl: `https://${hostname}/index.html#!/search`,
    cardTextIncludes: []
  };
}

function dynamicWebTracJob(hostname = "ctguilfordweb.myvscloud.com"): LocalReaderJob {
  return {
    id: "job-webtrac",
    courseKey: `webtrac:${hostname}`,
    targetDate: "2026-07-31",
    players: 2,
    requestedAt: "2026-07-31T12:00:00.000Z",
    expiresAt: "2026-07-31T12:05:00.000Z",
    courseName: "Guilford Lakes Golf Course",
    bookingUrl: getLocalReaderJobUrl(`webtrac:${hostname}`, "2026-07-31", 2),
    cardTextIncludes: []
  };
}

function loadReader() {
  const source = readFileSync(
    resolve(process.cwd(), "tools", "local-chrome-reader", "cps-reader.js"),
    "utf8"
  );
  const context: Record<string, unknown> = { URL };
  context.globalThis = context;
  runInNewContext(source, context);
  return context.TeeTimeSpotCpsReader as Reader;
}

function loadChronogolfReader() {
  const source = readFileSync(
    resolve(process.cwd(), "tools", "local-chrome-reader", "chronogolf-reader.js"),
    "utf8"
  );
  const context: Record<string, unknown> = { URL };
  context.globalThis = context;
  runInNewContext(source, context);
  return context.TeeTimeSpotChronogolfReader as Reader;
}

function loadTenForeReader() {
  const source = readFileSync(
    resolve(process.cwd(), "tools", "local-chrome-reader", "tenfore-reader.js"),
    "utf8"
  );
  const context: Record<string, unknown> = { URL };
  context.globalThis = context;
  runInNewContext(source, context);
  return context.TeeTimeSpotTenForeReader as Reader;
}

function loadEzLinksReader() {
  const source = readFileSync(
    resolve(process.cwd(), "tools", "local-chrome-reader", "ezlinks-reader.js"),
    "utf8"
  );
  const context: Record<string, unknown> = { URL };
  context.globalThis = context;
  runInNewContext(source, context);
  return context.TeeTimeSpotEzLinksReader as Reader;
}

function loadWebTracReader() {
  const source = readFileSync(
    resolve(process.cwd(), "tools", "local-chrome-reader", "webtrac-reader.js"),
    "utf8"
  );
  const context: Record<string, unknown> = { URL };
  context.globalThis = context;
  runInNewContext(source, context);
  return context.TeeTimeSpotWebTracReader as Reader;
}

function loadProphetReader() {
  const source = readFileSync(
    resolve(process.cwd(), "tools", "local-chrome-reader", "prophet-reader.js"),
    "utf8"
  );
  const context: Record<string, unknown> = { URL };
  context.globalThis = context;
  runInNewContext(source, context);
  return context.TeeTimeSpotProphetReader as Reader;
}

describe("local Chrome reader contract", () => {
  it("accepts every exact allowlisted reader route and rejects other routes", () => {
    for (const courseKey of LOCAL_READER_COURSE_KEYS) {
      const course = LOCAL_READER_COURSES[courseKey];
      const suffix =
        course.provider === "CPS"
          ? "?TeeOffTimeMin=0"
          : course.provider === "PROPHET"
            ? `?CourseId=${course.prophetCourseIds}&Date=2026-07-25&Time=AnyTime&Player=2&Hole=18`
            : "?date=2026-07-25&step=teetimes";
      expect(isAllowedLocalReaderUrl(courseKey, `${course.bookingUrl}${suffix}`)).toBe(true);
    }
    expect(
      isAllowedLocalReaderUrl(
        "grassy-hill",
        "https://grassyhill.cps.golf/onlineresweb/search-teetime/checkout"
      )
    ).toBe(false);
    expect(
      isAllowedLocalReaderUrl("grassy-hill", "https://fenwick.cps.golf/onlineresweb/search-teetime")
    ).toBe(false);
  });

  it("keeps the extension permissions and job allowlist synchronized", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "tools", "local-chrome-reader", "manifest.json"), "utf8")
    ) as {
      host_permissions: string[];
      content_scripts: Array<{ matches: string[] }>;
    };
    const backgroundSource = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "background.js"),
      "utf8"
    );
    const contentSource = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "content.js"),
      "utf8"
    );
    const contentMatches = manifest.content_scripts.flatMap((entry) => entry.matches);

    expect(manifest.host_permissions).toContain("https://*.cps.golf/*");
    expect(contentMatches).toContain("https://*.cps.golf/onlineresweb/search-teetime*");
    expect(manifest.host_permissions).toContain("https://fox.tenfore.golf/*");
    expect(contentMatches).toContain("https://fox.tenfore.golf/*");
    expect(manifest.host_permissions).toContain("https://*.ezlinksgolf.com/*");
    expect(contentMatches).toContain("https://*.ezlinksgolf.com/*");
    expect(manifest.host_permissions).toContain("https://*.myvscloud.com/*");
    expect(contentMatches).toContain("https://*.myvscloud.com/webtrac/web/search.html*");
    expect(backgroundSource).toContain("function isAllowlistedCpsJob(job)");
    expect(backgroundSource).toContain("function isAllowlistedTenForeJob(job)");
    expect(backgroundSource).toContain("function isAllowlistedEzLinksJob(job)");
    expect(backgroundSource).toContain("function isAllowlistedWebTracJob(job)");
    expect(backgroundSource).toContain('["EZLINKS_RENDERED", 1]');
    expect(backgroundSource).toContain('["WEBTRAC_RENDERED", 1]');
    expect(backgroundSource).toContain("async function submitPendingResult(tabId, pending)");
    expect(backgroundSource).toContain("pending.result = result");
    expect(backgroundSource).toContain('"RESULT_RETRY_PENDING"');
    expect(contentSource).toContain(
      "const pending = tabId ? stored.pendingJobs?.[tabId] : null;"
    );
    expect(contentSource).not.toContain("entries.length === 1");
    expect(contentSource).toContain("globalThis.TeeTimeSpotWebTracReader");
    expect(contentSource).toContain("waitForPassiveChallengeClearance");
    expect(contentSource).toContain(
      "The public page did not return to the allowlisted search route."
    );
    expect(backgroundSource).toContain("pending.job?.leaseExpiresAt");
    expect(backgroundSource).toContain("findReusableEzLinksTab(payload.job)");
    expect(backgroundSource).toContain("pending.closeTabOnFinish !== false");
    expect(backgroundSource).toContain("expired reader job");
    expect(backgroundSource).toContain("requesting fresh signed work");
    expect(backgroundSource).toContain(
      "/^cps:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.cps\\.golf$/u"
    );

    for (const courseKey of LOCAL_READER_COURSE_KEYS) {
      const course = LOCAL_READER_COURSES[courseKey];
      if (course.provider === "CPS") continue;
      const hostname = new URL(course.bookingUrl).hostname;
      expect(manifest.host_permissions).toContain(`https://${hostname}/*`);
      expect(contentMatches).toContain(
        course.provider === "PROPHET"
          ? `${course.bookingUrl.replace(/\/Home\/NIndex$/u, "")}/*`
          : `${course.bookingUrl}*`
      );
      expect(backgroundSource).toContain(courseKey);
      expect(backgroundSource).toContain(`"${course.courseName}"`);
      expect(backgroundSource).toContain(`"${hostname}"`);
    }
  });

  it("accepts future signed CPS jobs while rejecting unsafe hosts and routes", () => {
    const job = dynamicCpsJob();

    expect(getLocalReaderCourseKey(job.bookingUrl)).toBe("cps:future-public.cps.golf");
    expect(localReaderJobSchema.parse(job)).toMatchObject({
      courseKey: "cps:future-public.cps.golf",
      courseName: "Future Public Golf Course"
    });
    expect(loadReader().isAllowedPageUrl(job, `${job.bookingUrl}?TeeOffTimeMin=0`)).toBe(true);
    expect(() =>
      localReaderJobSchema.parse({
        ...job,
        bookingUrl: "https://evil.example/onlineresweb/search-teetime"
      })
    ).toThrow(/not allowlisted/u);
    expect(() =>
      localReaderJobSchema.parse({
        ...job,
        bookingUrl: `${job.bookingUrl}/checkout`
      })
    ).toThrow(/not allowlisted/u);
    expect(
      getLocalReaderCourseKey("https://nested.future.cps.golf/onlineresweb/search-teetime")
    ).toBeNull();
  });

  it("accepts exact TenFore tenant jobs and rejects unsafe paths and query data", () => {
    const job = dynamicTenForeJob();

    expect(getLocalReaderCourseKey("https://fox.tenfore.golf/gainfieldfarms")).toBe(
      "tenfore:gainfieldfarms"
    );
    expect(localReaderJobSchema.parse(job)).toMatchObject({
      courseKey: "tenfore:gainfieldfarms",
      courseName: "Gainfield Farms Golf Course"
    });
    expect(loadTenForeReader().isAllowedPageUrl(job, job.bookingUrl)).toBe(true);
    expect(loadTenForeReader()).toMatchObject({
      SKIP_DATE_SELECTION: true,
      SKIP_PLAYER_SELECTION: true
    });
    expect(() =>
      localReaderJobSchema.parse({
        ...job,
        bookingUrl: "https://fox.tenfore.golf/gainfieldfarms/checkout?date=2026-07-29"
      })
    ).toThrow(/not allowlisted/u);
    expect(() =>
      localReaderJobSchema.parse({
        ...job,
        bookingUrl: "https://fox.tenfore.golf/other-course?date=2026-07-29"
      })
    ).toThrow(/not allowlisted/u);
    expect(
      getLocalReaderCourseKey("https://fox.tenfore.golf/gainfieldfarms?token=secret")
    ).toBeNull();
  });

  it("accepts signed EZLinks tenant jobs while rejecting infrastructure and transaction paths", () => {
    const job = dynamicEzLinksJob();

    expect(getLocalReaderCourseKey("https://ballysapi.ezlinksgolf.com/")).toBe(
      "ezlinks:ballysapi.ezlinksgolf.com"
    );
    expect(localReaderJobSchema.parse(job)).toMatchObject({
      courseKey: "ezlinks:ballysapi.ezlinksgolf.com",
      courseName: "Bally's Golf Links at Ferry Point"
    });
    expect(loadEzLinksReader().isAllowedPageUrl(job, job.bookingUrl)).toBe(true);
    expect(
      getLocalReaderCourseKey("https://api.ezlinksgolf.com/index.html#!/search")
    ).toBeNull();
    expect(
      getLocalReaderCourseKey("https://nested.ballysapi.ezlinksgolf.com/index.html#!/search")
    ).toBeNull();
    expect(
      getLocalReaderCourseKey("https://ballysapi.ezlinksgolf.com/checkout")
    ).toBeNull();
    expect(
      getLocalReaderCourseKey("https://ballysapi.ezlinksgolf.com/index.htm#!/search")
    ).toBeNull();
    expect(
      getLocalReaderCourseKey("https://ballysapi.ezlinksgolf.com/index.html#/search")
    ).toBe("ezlinks:ballysapi.ezlinksgolf.com");
    expect(() =>
      localReaderJobSchema.parse({
        ...job,
        bookingUrl: "https://ballysapi.ezlinksgolf.com/index.html#!/checkout"
      })
    ).toThrow(/not allowlisted/u);
  });

  it("accepts signed MyVSCloud WebTrac jobs while rejecting unsafe hosts and routes", () => {
    const job = dynamicWebTracJob();

    expect(
      getLocalReaderCourseKey(
        "https://ctguilfordweb.myvscloud.com/webtrac/web/search.html?module=GR"
      )
    ).toBe("webtrac:ctguilfordweb.myvscloud.com");
    expect(localReaderJobSchema.parse(job)).toMatchObject({
      courseKey: "webtrac:ctguilfordweb.myvscloud.com",
      courseName: "Guilford Lakes Golf Course"
    });
    expect(loadWebTracReader()).toMatchObject({
      SKIP_DATE_SELECTION: true,
      SKIP_PLAYER_SELECTION: true
    });
    expect(loadWebTracReader().isAllowedPageUrl(job, job.bookingUrl)).toBe(true);
    expect(
      getLocalReaderCourseKey(
        "https://nested.ctguilfordweb.myvscloud.com/webtrac/web/search.html?module=GR"
      )
    ).toBeNull();
    expect(
      getLocalReaderCourseKey("https://ctguilfordweb.myvscloud.com/webtrac/web/cart.html?module=GR")
    ).toBeNull();
    expect(() =>
      localReaderJobSchema.parse({
        ...job,
        bookingUrl: job.bookingUrl.replace("/search.html?", "/cart.html?")
      })
    ).toThrow(/not allowlisted/u);
  });

  it("recognizes only the exact reader-candidate public booking surfaces", () => {
    expect(
      isLocalReaderCandidateUrl("https://secure.east.prophetservices.com/FrearParkV3/Home/NIndex")
    ).toBe(true);
    expect(isLocalReaderCandidateUrl("https://www.simsburyfarms.com/book-a-tee-time")).toBe(true);
    expect(
      isLocalReaderCandidateUrl("https://ctguilfordweb.myvscloud.com/webtrac/web/search.html")
    ).toBe(true);
    expect(
      isLocalReaderCandidateUrl("https://secure.east.prophetservices.com/OtherCourse/Home/NIndex")
    ).toBe(false);
    expect(isLocalReaderCandidateUrl("https://example.com/book-a-tee-time")).toBe(false);
  });

  it("shows the installed manifest version on the extension options page", () => {
    const optionsHtml = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "options.html"),
      "utf8"
    );
    const optionsSource = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "options.js"),
      "utf8"
    );

    expect(optionsHtml).toContain('id="readerVersion"');
    expect(optionsSource).toContain("chrome.runtime.getManifest()");
    expect(optionsSource).toContain("Reader version ${manifest.version}");
  });

  it("parses the current rendered CPS card layout", () => {
    document.title = "Grassy Hill Country Club";
    document.body.innerHTML = `
      <button class="btn-teesheet">
        <time role="timer" datetime="2026-07-25T11:02:00">11:02</time>
        <div>CART INCLUDED</div>
        <div>9 or 18 HOLES | 2 - 4 GOLFERS</div>
        <div>$70.00</div>
      </button>
      <button class="btn-teesheet">
        <time role="timer" datetime="2026-07-25T15:50:00">3:50</time>
        <div>CART RATE $17.00</div>
        <div>9 HOLES | 2 - 4 GOLFERS</div>
        <div>$43.00</div>
      </button>
      <button class="btn-teesheet">
        <time role="timer" datetime="2026-07-25T16:10:00">4:10</time>
        <div>18 HOLES | 1 GOLFERS</div>
        <div>$55.00</div>
      </button>
    `;

    const job = jobFor();
    const snapshot = loadReader().readSnapshot(document, `${job.bookingUrl}?TeeOffTimeMin=0`, job);

    expect(snapshot).toMatchObject({
      status: "AVAILABLE",
      slots: [
        {
          startsAtLocal: "2026-07-25T11:02:00",
          timeLabel: "11:02 AM",
          holes: [9, 18],
          minimumPlayers: 2,
          availableSpots: 4,
          priceCents: 7000,
          cartIncluded: true
        },
        {
          startsAtLocal: "2026-07-25T15:50:00",
          timeLabel: "3:50 PM",
          holes: [9],
          minimumPlayers: 2,
          availableSpots: 4,
          priceCents: 4300,
          cartIncluded: false
        }
      ]
    });
  });

  it("parses Guilford's signed-out WebTrac result rows without entering cart", () => {
    document.title = "Guilford Lakes Golf Course";
    document.body.innerHTML = `
      <h1>Guilford Lakes Golf Course</h1>
      <button>Date 07/31/2026</button>
      <table>
        <tr>
          <td data-title="Item Action"><button>Add To Cart</button></td>
          <td data-title="Time">4:20 pm</td>
          <td data-title="Date">07/31/2026</td>
          <td data-title="Holes">9 (Front)</td>
          <td data-title="Course">Guilford Lakes Golf Course</td>
          <td data-title="Open Slots">4</td>
        </tr>
        <tr>
          <td data-title="Item Action"><button>Add To Cart</button></td>
          <td data-title="Time">4:30 pm</td>
          <td data-title="Date">07/31/2026</td>
          <td data-title="Holes">9 (Front)</td>
          <td data-title="Course">Guilford Lakes Golf Course</td>
          <td data-title="Open Slots">1</td>
        </tr>
      </table>
    `;
    const job = dynamicWebTracJob();
    const snapshot = loadWebTracReader().readSnapshot(document, job.bookingUrl, job);

    expect(snapshot).toMatchObject({
      status: "AVAILABLE",
      readerVersion: "webtrac-rendered-v1",
      slots: [
        {
          startsAtLocal: "2026-07-31T16:20:00",
          timeLabel: "4:20 PM",
          holes: [9],
          minimumPlayers: 1,
          availableSpots: 4,
          priceCents: null,
          cartIncluded: false
        }
      ]
    });
  });

  it("fails WebTrac closed on a challenge, unsafe route, or changed row shape", () => {
    const reader = loadWebTracReader();
    const job = dynamicWebTracJob();

    document.body.innerHTML = "<main>Checking your browser before accessing this site</main>";
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "ACCESS_CHALLENGE",
      slots: []
    });

    document.body.innerHTML = `
      <div>07/31/2026</div>
      <table><tr><td data-title="Time">Loading</td><td data-title="Date">07/31/2026</td></tr></table>
    `;
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "READER_ERROR",
      slots: []
    });
    expect(
      reader.readSnapshot(document, job.bookingUrl.replace("/search.html?", "/cart.html?"), job)
    ).toMatchObject({ status: "PAGE_MISMATCH", slots: [] });
  });

  it("parses current signed-out Chronogolf tee-time cards", () => {
    document.title = "Book Crestbrook Park Golf Course Tee Times";
    document.body.innerHTML = `
      <div role="dialog">
        <div data-testid="teeTimeCard" role="button" tabindex="0">
          <span>8:40 AM</span>
          <span>from</span>
          <span>$50</span>
          <span title="1 player available">1</span>
          <span title="Hole count">9, 18</span>
        </div>
        <div data-testid="teeTimeCard" role="button" tabindex="0">
          <span>12:20 PM</span>
          <span>from</span>
          <span>$50</span>
          <span title="# of players available">2 - 4</span>
          <span title="Hole count">9, 18</span>
        </div>
      </div>
    `;
    const job = jobFor("crestbrook");
    const datedJob = {
      ...job,
      targetDate: "2026-07-26",
      bookingUrl: `${job.bookingUrl}?date=2026-07-26&step=teetimes`
    };

    expect(
      loadChronogolfReader().readSnapshot(document, `${datedJob.bookingUrl}&groupSize=2`, datedJob)
    ).toMatchObject({
      status: "AVAILABLE",
      slots: [
        {
          startsAtLocal: "2026-07-26T12:20:00",
          timeLabel: "12:20 PM",
          holes: [9, 18],
          minimumPlayers: 2,
          availableSpots: 4,
          priceCents: 5000
        }
      ]
    });
  });

  it("fails closed on malformed Chronogolf cards and unsafe paths", () => {
    document.title = "Book Crystal Lake Golf Club Tee Times";
    document.body.innerHTML = `
      <div data-testid="teeTimeCard" role="button">
        <span>Loading tee-time details</span>
      </div>
    `;
    const job = jobFor("crystal-lake");

    expect(loadChronogolfReader().readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "READER_ERROR",
      slots: [],
      readerVersion: "chronogolf-rendered-v1"
    });
    expect(
      loadChronogolfReader().readSnapshot(document, `${job.bookingUrl}/checkout`, job)
    ).toMatchObject({
      status: "PAGE_MISMATCH",
      slots: []
    });
  });

  it("recognizes the official Chanticlair Chronogolf profile", () => {
    const job = jobFor("chanticlair");

    expect(job).toMatchObject({
      courseName: "Chanticlair Golf Course",
      bookingUrl: "https://www.chronogolf.com/club/chanticlair-golf-club"
    });
    expect(
      isAllowedLocalReaderUrl("chanticlair", `${job.bookingUrl}?date=2026-07-27&step=teetimes`)
    ).toBe(true);
    expect(
      loadChronogolfReader().isAllowedPageUrl(
        job,
        `${job.bookingUrl}?date=2026-07-27&step=teetimes`
      )
    ).toBe(true);
  });

  it("recognizes the official Hyde Park Chronogolf profile", () => {
    const job = jobFor("hyde-park");

    expect(job).toMatchObject({
      courseName: "Hyde Park Golf Club",
      bookingUrl: "https://www.chronogolf.com/club/hyde-park-golf-club"
    });
    expect(getLocalReaderCourseKey(`${job.bookingUrl}?date=2026-07-29&step=teetimes`)).toBe(
      "hyde-park"
    );
    expect(
      loadChronogolfReader().isAllowedPageUrl(
        job,
        `${job.bookingUrl}?date=2026-07-29&step=teetimes`
      )
    ).toBe(true);
  });

  it("parses Frear Park's public rendered Prophet tee-time cards", () => {
    document.title = "Frear Park";
    document.body.innerHTML = `
      <input id="txtFromDateLarge" value="07/30/2026" />
      <div class="teeSheet">
        <a class="teetime">
          9:30 AM $62.00 Cart Price Included
          Frear Park Front/Frear Park Back 2-4 Golfers 18 Holes Select
        </a>
        <a class="teetime">
          12:15 PM $44.00
          Frear Park Front/Frear Park Back 1 to 1 Players 18
        </a>
      </div>
    `;
    const baseJob = jobFor("frear-park");
    const job = {
      ...baseJob,
      targetDate: "2026-07-30",
      bookingUrl: getLocalReaderJobUrl("frear-park", "2026-07-30", 2)
    };
    const pageUrl =
      "https://secure.east.prophetservices.com/FrearParkV3/(S(publicsession))/Home/NIndex/Home/nIndex?CourseId=1,2&Date=2026-7-30&Time=AnyTime&Player=2&Hole=18";

    expect(getLocalReaderCourseKey(baseJob.bookingUrl)).toBe("frear-park");
    expect(loadProphetReader().readSnapshot(document, pageUrl, job)).toMatchObject({
      status: "AVAILABLE",
      readerVersion: "legacy-prophet-rendered-v4",
      pageUrl: job.bookingUrl,
      slots: [
        {
          startsAtLocal: "2026-07-30T09:30:00",
          timeLabel: "9:30 AM",
          holes: [18],
          minimumPlayers: 2,
          availableSpots: 4,
          priceCents: 6200,
          cartIncluded: true
        }
      ]
    });
  });

  it("parses Simsbury Farms with its exact public Prophet tenant and course id", () => {
    document.title = "Simsbury Farms";
    document.body.innerHTML = `
      <input id="txtFromDateLarge" value="07/30/2026" />
      <div class="teeSheet">
        <a class="teetime">
          10:20 AM $54.00 Cart Price Included
          Simsbury Farms Golf Course 1 / 4 Players 18 $54.00
        </a>
      </div>
    `;
    const baseJob = jobFor("simsbury-farms");
    const job = {
      ...baseJob,
      targetDate: "2026-07-30",
      bookingUrl: getLocalReaderJobUrl("simsbury-farms", "2026-07-30", 2)
    };
    expect(job.bookingUrl).toBe(
      "https://secure.east.prophetservices.com/SimsburyFarmsV3/Home/NIndex?CourseId=1&Date=2026-07-30&Time=AnyTime&Player=2&Hole=18"
    );
    const pageUrl =
      "https://secure.east.prophetservices.com/SimsburyFarmsV3/(S(publicsession))/Home/NIndex/Home/nIndex?CourseId=1&Date=2026-7-30&Time=AnyTime&Player=2&Hole=18";

    expect(getLocalReaderCourseKey(baseJob.bookingUrl)).toBe("simsbury-farms");
    expect(loadProphetReader().readSnapshot(document, pageUrl, job)).toMatchObject({
      status: "AVAILABLE",
      readerVersion: "legacy-prophet-rendered-v4",
      pageUrl: job.bookingUrl,
      slots: [
        {
          startsAtLocal: "2026-07-30T10:20:00",
          availableSpots: 4,
          holes: [18],
          priceCents: 5400
        }
      ]
    });
  });

  it("accepts Simsbury's visible week label when its public empty sheet omits the date input", () => {
    document.title = "Simsbury Farms Golf Course";
    document.body.innerHTML = `
      <table><tr><td>Thursday July 30</td><td>Friday July 31</td></tr></table>
      <div>No tee times available, please try different criteria.</div>
    `;
    const baseJob = jobFor("simsbury-farms");
    const job = {
      ...baseJob,
      targetDate: "2026-07-30",
      bookingUrl: getLocalReaderJobUrl("simsbury-farms", "2026-07-30", 2)
    };
    const pageUrl =
      "https://secure.east.prophetservices.com/SimsburyFarmsV3/(S(publicsession))/Home/NIndex/Home/nIndex?CourseId=1&Date=2026-7-30&Time=AnyTime&Player=2&Hole=18";

    expect(loadProphetReader().readSnapshot(document, pageUrl, job)).toMatchObject({
      status: "NO_AVAILABILITY",
      slots: []
    });

    document.body.innerHTML = `
      <table><tr><td>Friday July 31</td></tr></table>
      <div>No tee times available, please try different criteria.</div>
    `;
    expect(loadProphetReader().readSnapshot(document, pageUrl, job)).toMatchObject({
      status: "PAGE_MISMATCH",
      slots: []
    });
  });

  it("fails Frear Park closed on a changed date, route, or card shape", () => {
    const baseJob = jobFor("frear-park");
    const job = {
      ...baseJob,
      targetDate: "2026-07-30",
      bookingUrl: getLocalReaderJobUrl("frear-park", "2026-07-30", 2)
    };
    const reader = loadProphetReader();
    const pageUrl =
      "https://secure.east.prophetservices.com/FrearParkV3/(S(publicsession))/Home/NIndex/Home/nIndex?CourseId=1,2&Date=2026-07-30&Time=AnyTime&Player=2&Hole=18";

    document.body.innerHTML = `
      <input id="txtFromDateLarge" value="07/31/2026" />
      <div class="teeSheet"><a class="teetime">Loading</a></div>
    `;
    expect(reader.readSnapshot(document, pageUrl, job)).toMatchObject({
      status: "PAGE_MISMATCH",
      slots: []
    });

    document.body.innerHTML = `
      <input id="txtFromDateLarge" value="07/30/2026" />
      <div class="teeSheet"><a class="teetime">Loading</a></div>
    `;
    expect(reader.readSnapshot(document, pageUrl, job)).toMatchObject({
      status: "READER_ERROR",
      slots: []
    });
    expect(
      reader.readSnapshot(
        document,
        pageUrl.replace("/Home/NIndex/Home/nIndex", "/Home/Checkout"),
        job
      )
    ).toMatchObject({ status: "PAGE_MISMATCH", slots: [] });
    expect(reader.readSnapshot(document, `${pageUrl}&Date=2026-07-31`, job)).toMatchObject({
      status: "PAGE_MISMATCH",
      slots: []
    });
    expect(
      isAllowedLocalReaderUrl(
        "frear-park",
        "https://secure.east.prophetservices.com/FrearParkV3/Home/NIndex?Date=2026-07-30"
      )
    ).toBe(false);
  });

  it("parses the legacy CPS material-card layout", () => {
    document.title = "Overpeck Golf Course";
    document.body.innerHTML = `
      <mat-card class="mat-card">
        <time datetime="2026-07-25T08:20:00">8:20 AM</time>
        <div>18 HOLES | 1 - 4 GOLFERS</div>
        <div>$52</div>
      </mat-card>
    `;
    const job = jobFor("overpeck");

    expect(loadReader().readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "AVAILABLE",
      slots: [
        {
          startsAtLocal: "2026-07-25T08:20:00",
          holes: [18],
          minimumPlayers: 1,
          availableSpots: 4,
          priceCents: 5200
        }
      ]
    });
  });

  it("keeps Candia Woods isolated from The Oaks tenant", () => {
    document.title = "Candia Woods Golf Links";
    document.body.innerHTML = `
      <button class="btn-teesheet">
        <time datetime="2026-07-25T09:10:00">9:10 AM</time>
        <div>18 HOLES | 2 - 4 GOLFERS</div>
      </button>
    `;
    const job = jobFor("candia-woods");

    expect(loadReader().readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "AVAILABLE",
      slots: [{ startsAtLocal: "2026-07-25T09:10:00" }]
    });
    expect(job.bookingUrl).toContain("candiawoods.cps.golf");
    expect(
      isAllowedLocalReaderUrl(
        "candia-woods",
        "https://oaksgolflinks.cps.golf/onlineresweb/search-teetime"
      )
    ).toBe(false);
  });

  it("reports challenge and page mismatch states without returning slots", () => {
    document.title = "Just a moment";
    document.body.innerHTML = "<main>Checking your browser before accessing this site</main>";
    const reader = loadReader();
    const job = jobFor();

    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "ACCESS_CHALLENGE",
      slots: []
    });
    expect(reader.readSnapshot(document, `${job.bookingUrl}/checkout`, job)).toMatchObject({
      status: "PAGE_MISMATCH",
      slots: []
    });
  });

  it("parses rendered TenFore cards without reading challenge-protected requests", () => {
    document.title = "TenFore | Golf Software";
    document.body.innerHTML = `
      <div class="filter-section" data-filter-key="selectedDate">
        <div class="filter-value">Jul 29, 2026</div>
      </div>
      <div class="bg-white text-xl font-medium leading-none rounded-t-lg p-4 pb-2">
        <div><div class="text-2xl font-bold">1:20 PM</div></div>
        <div><span>18</span><span>1-4</span></div>
        <div><span>$42.00</span><span>Online Booking</span></div>
      </div>
      <div class="bg-white text-xl font-medium leading-none rounded-t-lg p-4 pb-2">
        <div><div class="text-2xl font-bold">2:10 PM</div></div>
        <div><span>9</span><span>1-2</span></div>
        <div><span>$25.00</span><span>Online Booking</span></div>
      </div>
    `;
    const job = dynamicTenForeJob();
    const reader = loadTenForeReader() as Reader & {
      countRenderedSlots: (documentRoot: Document) => number;
    };

    expect(document.querySelectorAll(".text-2xl.font-bold")).toHaveLength(2);
    expect(reader.countRenderedSlots(document)).toBe(2);
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "AVAILABLE",
      readerVersion: "tenfore-rendered-v1",
      slots: [
        {
          startsAtLocal: "2026-07-29T13:20:00",
          holes: [18],
          minimumPlayers: 1,
          availableSpots: 4,
          priceCents: 4200
        }
      ]
    });
  });

  it("fails TenFore closed on a challenge, wrong date, or changed card shape", () => {
    const reader = loadTenForeReader();
    const job = dynamicTenForeJob();

    document.body.innerHTML = "<main>Verify you are human</main>";
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "ACCESS_CHALLENGE",
      slots: []
    });

    document.body.innerHTML = `
      <div class="filter-section" data-filter-key="selectedDate">
        <div class="filter-value">Jul 30, 2026</div>
      </div>
    `;
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "PAGE_MISMATCH",
      slots: []
    });

    document.body.innerHTML = `
      <div class="filter-section" data-filter-key="selectedDate">
        <div class="filter-value">Jul 29, 2026</div>
      </div>
      <div><div class="text-2xl font-bold">1:20 PM</div>Online Booking</div>
    `;
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "READER_ERROR",
      slots: []
    });
  });

  it("parses the current signed-out EZLinks result cards", () => {
    document.title = "Find Tee Times - Bally's (App)";
    document.body.innerHTML = `
      <input id="pickerDate" value="07/31/2026" />
      <div class="search-result-data">
        <strong>07/31/2026 / 3 players</strong>
        <strong>3 tee times</strong>
        <span>Course: Bally's Golf Links at Ferry Point</span>
      </div>
      <ul class="tee-time-block">
        <li>
          <span class="time">11:40 AM</span>
          <div class="price"><strong>$283.00</strong></div>
          <div title="18 holes"><img alt="Tee Time feature: 18 holes" /></div>
          <div title="Walking"><img alt="Tee Time feature: Walking" /></div>
          <span class="players">2–4 Players</span>
        </li>
        <li>
          <span class="time">2:30 PM</span>
          <div class="price"><strong>$225.00</strong></div>
          <div title="18 holes"><img alt="Tee Time feature: 18 holes" /></div>
          <span class="players">2 Players</span>
        </li>
        <li>
          <span class="time">4:10 PM</span>
          <div class="price"><strong>$199</strong></div>
          <div title="9 holes"><img alt="Tee Time feature: 9 holes" /></div>
          <div title="Include Cart"><img alt="Tee Time feature: Include Cart" /></div>
          <span class="players">3 Players</span>
        </li>
      </ul>
    `;
    const job = dynamicEzLinksJob();

    expect(loadEzLinksReader().readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "AVAILABLE",
      slots: [
        {
          startsAtLocal: "2026-07-31T11:40:00",
          timeLabel: "11:40 AM",
          holes: [18],
          minimumPlayers: 2,
          availableSpots: 4,
          priceCents: 28300,
          cartIncluded: false
        },
        {
          startsAtLocal: "2026-07-31T16:10:00",
          timeLabel: "4:10 PM",
          holes: [9],
          minimumPlayers: 3,
          availableSpots: 3,
          priceCents: 19900,
          cartIncluded: true
        }
      ]
    });
  });

  it("accepts an EZLinks facility name followed by its provider course suffix", () => {
    const reader = loadEzLinksReader();
    const job = {
      ...dynamicEzLinksJob("lakeofislesbest.ezlinksgolf.com"),
      targetDate: "2026-08-02",
      courseName: "Lake of Isles"
    };
    document.title = "Find Tee Times - Lake of Isles Best Available";
    document.body.innerHTML = `
      <input id="pickerDate" value="08/02/2026" />
      <div class="search-result-data">
        <strong>08/02/2026 / 2 players</strong>
        <strong>0 tee times</strong>
        <span>Course: Lake of Isles - North Course (Resort)</span>
      </div>
    `;

    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "NO_AVAILABILITY",
      slots: []
    });

    document.querySelector(".search-result-data span")!.textContent =
      "Course: Lake of Isles Resort";
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "PAGE_MISMATCH",
      slots: []
    });
  });

  it("fails EZLinks closed on the wrong course, wrong date, challenge, or changed cards", () => {
    const reader = loadEzLinksReader();
    const job = dynamicEzLinksJob();
    document.title = "Find Tee Times";
    document.body.innerHTML = `
      <input id="pickerDate" value="08/01/2026" />
      <div class="search-result-data">0 tee times Course: Bally's Golf Links at Ferry Point</div>
    `;
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "PAGE_MISMATCH"
    });

    document.body.innerHTML = `
      <input id="pickerDate" value="07/31/2026" />
      <div class="search-result-data">0 tee times Course: Other Golf Course</div>
    `;
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "PAGE_MISMATCH"
    });

    document.body.innerHTML = "<main>Just a moment... verify you are human</main>";
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "ACCESS_CHALLENGE"
    });

    document.body.innerHTML = "<main>Performing security verification</main>";
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "ACCESS_CHALLENGE"
    });

    document.body.innerHTML = `
      <input id="pickerDate" value="07/31/2026" />
      <div class="search-result-data">1 tee time Course: Bally's Golf Links at Ferry Point</div>
      <ul class="tee-time-block"><li><span>Changed result</span></li></ul>
    `;
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "READER_ERROR"
    });

    document.body.innerHTML = `
      <input id="pickerDate" value="07/31/2026" />
      <div class="search-result-data">2 tee times Course: Bally's Golf Links at Ferry Point</div>
      <ul class="tee-time-block">
        <li>
          <span class="time">11:40 AM</span>
          <div title="18 holes"></div>
          <span class="players">2-4 Players</span>
        </li>
      </ul>
    `;
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "READER_ERROR",
      slots: []
    });

    document.body.innerHTML = `
      <input id="pickerDate" value="07/31/2026" />
      <div class="search-result-data">0 tee times Course: Bally's Golf Links at Ferry Point</div>
      <div>Please Wait...</div>
    `;
    expect(reader.readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "READER_ERROR",
      slots: []
    });
    expect(
      reader.readSnapshot(document, "https://ballysapi.ezlinksgolf.com/checkout", job)
    ).toMatchObject({ status: "PAGE_MISMATCH" });
  });

  it("waits passively for an exact EZLinks Cloudflare challenge to clear", async () => {
    const reader = loadEzLinksReader();
    const job = dynamicEzLinksJob("lakeofislesbest.ezlinksgolf.com");
    const challengeUrl =
      "https://lakeofislesbest.ezlinksgolf.com/index.html?__cf_chl_rt_tk=temporary#!/search";
    expect(reader.isExpectedChallengePage?.(job, challengeUrl)).toBe(true);
    expect(
      reader.isExpectedChallengePage?.(
        job,
        "https://lakeofislesbest.ezlinksgolf.com/index.html?redirect=checkout#!/search"
      )
    ).toBe(false);

    document.body.innerHTML = "<main>Performing security verification</main>";
    let waits = 0;
    const passiveWindow = {
      setTimeout(callback: () => void) {
        waits += 1;
        if (waits === 2) {
          document.body.innerHTML = '<input id="pickerDate" value="07/31/2026" />';
        }
        callback();
        return waits;
      }
    };
    await expect(
      reader.waitForPassiveChallengeClearance?.(document, passiveWindow, 1_000)
    ).resolves.toBe(true);
    expect(waits).toBe(2);

    document.body.innerHTML = "<main>Performing security verification</main>";
    await expect(
      reader.waitForPassiveChallengeClearance?.(document, passiveWindow, 0)
    ).resolves.toBe(false);
  });

  it("fails closed when tee cards are visible but cannot be parsed", () => {
    document.title = "Grassy Hill Country Club";
    document.body.innerHTML = `
      <button class="btn-teesheet">
        <div>Loading tee-time details</div>
      </button>
    `;
    const job = jobFor();

    expect(loadReader().readSnapshot(document, job.bookingUrl, job)).toMatchObject({
      status: "READER_ERROR",
      slots: [],
      readerVersion: "cps-rendered-v1"
    });
  });

  it("validates jobs and results and rejects malformed availability", () => {
    expect(localReaderJobSchema.parse(jobFor())).toMatchObject({
      courseKey: "grassy-hill",
      players: 2
    });

    expect(() =>
      localReaderResultSchema.parse({
        jobId: "job-1",
        courseKey: "grassy-hill",
        status: "AVAILABLE",
        observedAt: "2026-07-24T12:00:00.000Z",
        pageUrl: LOCAL_READER_COURSES["grassy-hill"].bookingUrl,
        pageTitle: "Grassy Hill Country Club",
        slots: [],
        readerVersion: "test"
      })
    ).toThrow(/at least one slot/u);
  });

  it("signs job traffic and rejects a changed payload", () => {
    const secret = "test-device-secret-1234";
    const payload = '{"jobId":"job-1"}';
    const signature = signLocalReaderPayload(secret, payload);

    expect(verifyLocalReaderSignature(secret, payload, signature)).toBe(true);
    expect(verifyLocalReaderSignature(secret, '{"jobId":"job-2"}', signature)).toBe(false);
  });

  it("normalizes copied device tokens before saving and signing", () => {
    const backgroundSource = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "background.js"),
      "utf8"
    );
    const optionsSource = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "options.js"),
      "utf8"
    );

    expect(backgroundSource).toContain(
      'deviceToken: (settings.deviceToken || "").replace(/^\\uFEFF/u, "").trim()'
    );
    expect(optionsSource).toContain('.value.replace(/^\\uFEFF/u, "")');
    expect(optionsSource).toContain(".trim();");
  });

  it("selects courses and local dates without using page locale globals", () => {
    const contentSource = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "content.js"),
      "utf8"
    );

    expect(contentSource).not.toContain("Intl.DateTimeFormat");
    expect(contentSource).toContain("MONTH_NAMES[targetMonth - 1]");
    expect(contentSource).toContain("MONTH_SHORT_INDEX");
    expect(contentSource).toContain("async function chooseCourse(job)");
    expect(contentSource).toContain("async function choosePlayers(players)");
    expect(contentSource).toContain("reader.SKIP_PLAYER_SELECTION !== true");
    expect(contentSource).toContain("reader.SKIP_DATE_SELECTION !== true");
    expect(contentSource).toContain("const deadline = Date.now() + 10_000");
    expect(contentSource).toContain("await delay(100)");
    expect(contentSource).toContain(
      "const [targetYear, targetMonth, targetDayNumber] = targetDate"
    );
    expect(contentSource).toContain("const selectionDeadline = Date.now() + 10_000");
    expect(contentSource).toContain('button.getAttribute("aria-disabled") !== "true"');
    expect(contentSource).toContain(
      'if (dayNumbers.length > 0) return (visible?.textContent || "").trim()'
    );
  });

  it("surfaces reader setup errors without exposing private browser state", () => {
    const contentSource = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "content.js"),
      "utf8"
    );
    const backgroundSource = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "background.js"),
      "utf8"
    );

    expect(contentSource).toContain("`Reader error: ${detail}`.slice(0, 200)");
    expect(backgroundSource).toContain(": result.status,");
    expect(backgroundSource).not.toContain("document.cookie");
    expect(backgroundSource).not.toContain("localStorage");
  });

  it("retries fast page loads after the tab-to-job mapping settles", () => {
    const contentSource = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "content.js"),
      "utf8"
    );
    const backgroundSource = readFileSync(
      resolve(process.cwd(), "tools", "local-chrome-reader", "background.js"),
      "utf8"
    );

    expect(contentSource).toContain("PENDING_JOB_LOOKUP_LIMIT = 20");
    expect(contentSource).toContain("setTimeout(() => void readPendingJob(), 250)");
    expect(backgroundSource).toContain(
      'if (changeInfo.status === "complete") void wakePendingTab(tabId)'
    );
    expect(backgroundSource).toContain("await wakePendingTab(tab.id)");
  });

  it("rejects slots for the wrong date or an unsupported player count", () => {
    const job = localReaderJobSchema.parse(jobFor());
    const result = localReaderResultSchema.parse({
      jobId: "job-1",
      courseKey: "grassy-hill",
      status: "AVAILABLE",
      observedAt: "2026-07-24T12:01:00.000Z",
      pageUrl: LOCAL_READER_COURSES["grassy-hill"].bookingUrl,
      pageTitle: "Grassy Hill Country Club",
      slots: [
        {
          startsAtLocal: "2026-07-24T11:02:00",
          timeLabel: "11:02 AM",
          holes: [9, 18],
          minimumPlayers: 2,
          availableSpots: 4,
          priceCents: 7000,
          cartIncluded: true
        }
      ],
      readerVersion: "test"
    });

    expect(() => validateLocalReaderResultForJob(job, result)).toThrow(/requested local date/u);
    expect(() =>
      validateLocalReaderResultForJob({ ...job, targetDate: "2026-07-24", players: 1 }, result)
    ).toThrow(/requested players/u);
  });
});
