// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { CPS_API_PATH, CPS_PUBLIC_BUILD, parseCpsCatalog, parseCpsConfiguration, parseCpsOptions } from "./cps-source";
import { cpsAvailabilityQuery, cpsBootstrapReadAllowed, cpsLocalInstant, executeCps, inspectCps, normalizeCpsAvailability, type CpsDependencies } from "./cps-executor";

const source = { officialUrl: "https://www.thebobgc.com/", bookingUrl: "https://thebobgcpa.cps.golf/", venueName: "Bob O'Connor Golf Course",
  venueAddress: "5370 Schenley Dr, Pittsburgh, PA 15217, USA", timeZone: "America/New_York" };
const input = { date: "2026-10-23", players: 2, startTime: "08:00", endTime: "18:00", timeZone: source.timeZone };
const uuid = "00000000-0000-4000-8000-000000000001";
const config = () => ({ siteName: "thebobgcpa", onlineApi: "https://thebobgcpa.cps.golf" + CPS_API_PATH,
  authorityBaseUrl: "https://thebobgcpa.cps.golf/identityapi", clientId: "public-client", websiteId: "00000000-0000-0000-0000-000000000000",
  apiKey: "syntheticPublishedKey", buildNumber: CPS_PUBLIC_BUILD });
const options = () => ({ webSiteId: "public-site", courseOptions: [{ courseId: 1, courseName: source.venueName, webSiteId: "public-site" }], reservationOptions: { terminalId: 1 } });
const courses = () => [{ courseId: 1, courseName: source.venueName, timezoneId: source.timeZone, websiteId: "public-site", active: true as const, holes: 9 as const }];
const metadata = () => parseCpsCatalog(courses(), parseCpsOptions(options(), parseCpsConfiguration(config(), source)), source);
const row = (id = 7) => ({ teeSheetId: id, courseId: 1, startTime: "2026-10-23T10:30:00", availableParticipantNo: [1, 2, 3, 4], holes: 9 as const, minPlayer: 1 });
const envelope = (rows: unknown[] = [row()], transactionId = uuid) => ({ isSuccess: true, transactionId, content: rows });
const footer = "<footer>© 2022 Bob O'Connor Golf Course | 5370 Schenley Drive | Pittsburgh, PA 15217 | Phone: 412.622.6959</footer>";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
type Change = (url: URL, init: RequestInit, normal: () => Response) => Response | Promise<Response>;
function setup(change?: Change) {
  const reads: Array<{ url: URL; init: RequestInit }> = [], families: string[] = []; let active = 0, maxActive = 0, transactionId = "";
  const deps: CpsDependencies = { now: () => new Date("2026-10-22T00:00:00Z"),
    requestLease: async <T>(family: string, work: () => Promise<T>) => {
      active++; maxActive = Math.max(maxActive, active); families.push(family);
      try { return { acquired: true as const, value: await work() }; } finally { active--; }
    },
    fetch: (async (value, rawInit = {}) => {
      expect(active).toBe(1); const url = new URL(String(value)), init = rawInit;
      reads.push({ url, init });
      const normal = () => {
        if (url.hostname === "thebobgc.com") return new Response(null, { status: 301, headers: { location: source.officialUrl } });
        if (url.hostname === "www.thebobgc.com") {
          if (url.pathname === "/teetimes") return new Response(null, { status: 302, headers: { location: "/bookteetimes" } });
          return new Response(`<body>${url.pathname === "/" ? '<a href="/teetimes">Book a Tee Time</a>' : `<iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>`}${footer}</body>`, { headers: { "content-type": "text/html" } });
        }
        if (url.pathname.endsWith("/Configuration")) return json(config());
        if (url.pathname.includes("/GetAllOptions/")) return json(options());
        if (url.pathname.endsWith("/OnlineCourses")) return json(courses());
        if (url.pathname.endsWith("/RegisterTransactionId")) { transactionId = JSON.parse(String(init.body)).transactionId; return json(true); }
        if (url.pathname.endsWith("/TeeTimes")) {
          expect(url.searchParams.get("transactionId")).toBe(transactionId);
          const date = new Date(url.searchParams.get("searchDate")!).toISOString().slice(0, 10);
          return json(envelope([{ ...row(), startTime: date + "T10:30:00" }], transactionId));
        }
        throw new Error("UNEXPECTED_TEST_REQUEST");
      };
      return change ? change(url, init, normal) : normal();
    }) as typeof fetch };
  return { deps, reads, families, get active() { return active; }, get maxActive() { return maxActive; } };
}
const execute = (deps: CpsDependencies, request = input) => executeCps(source, metadata(), { courseId: "course-1" }, request, deps);

describe("CPS fixed fresh public reads", () => {
  it("inspects without registration and rederives fresh official/config/catalog facts on each execution", async () => {
    const fixture = setup(), saved = await inspectCps(source, fixture.deps);
    expect(saved).toEqual(metadata()); expect(fixture.reads).toHaveLength(6); expect(fixture.reads.every(read => read.init.method === "GET")).toBe(true);
    fixture.reads.length = 0;
    const slots = await executeCps(source, saved, { courseId: "course-1" }, input, fixture.deps);
    expect(slots).toEqual([{ sourceId: "cps-thebobgcpa-7", startsAt: "2026-10-23T14:30:00.000Z", availableSpots: 4,
      bookingUrl: source.bookingUrl, resourceId: "cps-course:1", holes: 9 }]);
    expect(fixture.reads).toHaveLength(8); expect(fixture.maxActive).toBe(1); expect(fixture.active).toBe(0);
    const post = fixture.reads.filter(read => read.init.method === "POST"); expect(post).toHaveLength(1);
    expect(post[0].url.pathname).toBe(CPS_API_PATH + "/RegisterTransactionId");
    expect(Object.keys(JSON.parse(String(post[0].init.body)))).toEqual(["transactionId"]);
    expect(fixture.reads.every(read => read.init.credentials === "omit" && read.init.redirect === "manual" && read.init.signal instanceof AbortSignal)).toBe(true);
    expect(JSON.stringify(saved)).not.toMatch(/syntheticPublished|public-client|public-site|transactionId/iu);
    const headers = new Headers(fixture.reads.find(read => read.url.pathname.endsWith("/Configuration"))!.init.headers);
    expect(Object.fromEntries(headers)).toEqual({ accept: "application/json", referer: source.bookingUrl, "user-agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)" });
  });
  it("supports changed date/players through fresh UUID reads and preserves source IDs across recipe versions", async () => {
    const fixture = setup(), changed = { ...input, date: "2026-10-24", players: 3 };
    const first = await execute(fixture.deps), second = await execute(fixture.deps, changed);
    expect(first[0].sourceId).toBe(second[0].sourceId); expect(second[0].startsAt).toBe("2026-10-24T14:30:00.000Z");
    const posts = fixture.reads.filter(read => read.init.method === "POST"); expect(posts).toHaveLength(2);
    expect(posts[0].init.body).not.toBe(posts[1].init.body);
    const sheet = fixture.reads.at(-1)!.url; expect(sheet.searchParams.get("searchDate")).toBe("Sat Oct 24 2026");
    expect(sheet.searchParams.get("numberOfPlayer")).toBe("0"); expect(sheet.searchParams.has("page")).toBe(false);
  });
  it("follows only observed official redirects and link, including one bare-to-www root redirect", async () => {
    const fixture = setup();
    expect(await inspectCps({ ...source, officialUrl: "https://thebobgc.com/" }, fixture.deps)).toMatchObject({ family: "CPS" });
    expect(fixture.reads.slice(0, 4).map(read => read.url.pathname)).toEqual(["/", "/", "/teetimes", "/bookteetimes"]);
  });
  it.each(["redirect", "link"])("handles the retained two-link homepage and a %s to its already queued booking page", async kind => {
    const fixture = setup((url, _init, normal) => {
      if (url.hostname !== "www.thebobgc.com") return normal();
      const content = url.pathname === "/" ? '<a href="/teetimes">BOOK A TEE TIME</a><a href="/bookteetimes">Tee time reservations</a>' :
        url.pathname === "/teetimes" && kind === "link" ? '<a href="/bookteetimes">Book a Tee Time</a>' : undefined;
      return content ? new Response(`<body>${content}${footer}</body>`, { headers: { "content-type": "text/html" } }) : normal();
    });
    expect(await inspectCps(source, fixture.deps)).toMatchObject({ family: "CPS" });
    expect(fixture.reads.filter(read => read.url.hostname === "www.thebobgc.com").map(read => read.url.pathname))
      .toEqual(["/", "/teetimes", "/bookteetimes"]);
    expect(fixture.reads.every(read => read.init.method === "GET")).toBe(true);
  });
  it("rejects a current official challenge and private/foreign redirects before provider reads", async () => {
    for (const location of ["/login", "https://foreign.example.com/teetimes"]) {
      const fixture = setup(() => new Response(null, { status: 302, headers: { location } }));
      await expect(execute(fixture.deps)).rejects.toThrow("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
      expect(fixture.reads).toHaveLength(1);
    }
    const fixture = setup(() => new Response(`<title>Just a moment...</title><body>Verify you are human${footer}</body>`, { headers: { "content-type": "text/html" } }));
    await expect(execute(fixture.deps)).rejects.toThrow("ACCESS_REQUIRED"); expect(fixture.reads).toHaveLength(1);
  });
  it.each([401, 403, 429, 500])("preserves HTTP %i as failure rather than EMPTY or retrying forbidden paths", async status => {
    const fixture = setup(url => url.pathname.endsWith("/Configuration") ? json({}, status) :
      new Response(`<body><iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>${footer}</body>`, { headers: { "content-type": "text/html" } }));
    await expect(execute(fixture.deps)).rejects.toThrow(status === 429 ? "PROVIDER_THROTTLED" : status === 401 || status === 403 ? "ACCESS_REQUIRED" : "ADAPTER_TRANSPORT_FAILED");
    expect(fixture.reads.some(read => read.init.method === "POST")).toBe(false);
  });
  it.each(["name", "timezone", "catalog", "registration", "root", "row"])("rejects changed %s before returning any partial matches", async kind => {
    const fixture = setup((url, init, normal) => {
      if (url.pathname.endsWith("/OnlineCourses") && ["name", "timezone", "catalog"].includes(kind)) return json([{ ...courses()[0],
        ...(kind === "name" ? { courseName: "Another Golf Course" } : kind === "timezone" ? { timezoneId: "America/Los_Angeles" } : { courseId: 2 }) }]);
      if (kind === "registration" && init.method === "POST") return json({ token: "never-used" });
      if (url.pathname.endsWith("/TeeTimes") && kind === "root") return json({ ...JSON.parse("{}"), content: [] });
      if (url.pathname.endsWith("/TeeTimes") && kind === "row") return json(envelope([row(), { ...row(8), courseId: 99 }], url.searchParams.get("transactionId")!));
      return normal();
    });
    await expect(execute(fixture.deps)).rejects.toThrow(); expect(fixture.active).toBe(0);
    expect(fixture.reads.every(read => !/lock|token|login|reservation|account/iu.test(read.url.pathname.replace(CPS_API_PATH, "")))).toBe(true);
  });
  it("keeps the lease until the full dated body is consumed", async () => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const fixture = setup((url, _init, normal) => {
      if (!url.pathname.endsWith("/TeeTimes")) return normal();
      const body = JSON.stringify(envelope([row()], url.searchParams.get("transactionId")!));
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); entered.resolve();
        void release.promise.then(() => controller.close()); } }), { headers: { "content-type": "application/json" } });
    });
    const pending = execute(fixture.deps); await entered.promise; expect(fixture.active).toBe(1);
    release.resolve(); expect(await pending).toHaveLength(1); expect(fixture.active).toBe(0);
  });
  it("cancels active reads without starting successor requests and rejects expired deadlines/misused simulator input before transport", async () => {
    const started = Promise.withResolvers<void>(), abort = new AbortController();
    const fixture = setup((_url, init) => new Promise<Response>((_resolve, reject) => { started.resolve();
      init.signal!.addEventListener("abort", () => reject(new Error("TEST_ABORT")), { once: true }); }));
    const pending = execute({ ...fixture.deps, signal: abort.signal }); await started.promise; abort.abort();
    await expect(pending).rejects.toThrow(); expect(fixture.reads).toHaveLength(1); expect(fixture.active).toBe(0);
    const untouched = setup();
    await expect(execute({ ...untouched.deps, deadlineAt: new Date(0) })).rejects.toThrow("DEADLINE_EXCEEDED");
    for (const request of [{ ...input, durationMinutes: 60 }, { ...input, players: 5 }, { ...input, timeZone: "America/Los_Angeles" }])
      await expect(executeCps(source, metadata(), { courseId: "course-1" }, request, untouched.deps)).rejects.toThrow("ADAPTER_TARGET_MISMATCH");
    expect(untouched.reads).toHaveLength(0);
  });
});

describe("CPS complete full-sheet normalization", () => {
  const normalize = (value: unknown, request = input) => normalizeCpsAvailability(value, uuid, metadata(), source, request, new Date("2026-10-22T00:00:00Z"));
  it("uses exact party membership/minPlayer and an end-exclusive window before publishing a stable ID", () => {
    const result = normalize(envelope([row(), { ...row(8), availableParticipantNo: [1, 3, 4] }, { ...row(9), minPlayer: 3 },
      { ...row(10), startTime: "2026-10-23T18:00:00" }, { ...row(11), startTime: "2026-10-23T08:00:00" }]));
    expect(result.map(slot => slot.sourceId)).toEqual(["cps-thebobgcpa-11", "cps-thebobgcpa-7"]);
    expect(normalize(envelope([]))).toEqual([]);
  });
  it.each([
    ["wrong UUID", { ...envelope(), transactionId: "00000000-0000-4000-8000-000000000002" }],
    ["failed envelope", { ...envelope([]), isSuccess: false }], ["extra pagination", { ...envelope([]), totalCount: 0 }],
    ["bare array", []], ["duplicate", envelope([row(), row()])], ["wrong date", envelope([{ ...row(), startTime: "2026-10-24T10:30:00" }])],
    ["invalid calendar", envelope([{ ...row(), startTime: "2026-02-30T10:30:00" }])], ["foreign course", envelope([{ ...row(), courseId: 2 }])],
    ["duplicate party", envelope([{ ...row(), availableParticipantNo: [2, 2] }])], ["invalid party", envelope([{ ...row(), availableParticipantNo: [0] }])],
    ["missing holes", envelope([{ ...row(), holes: undefined }])], ["truncated nonarray", { ...envelope(), content: null }],
    ["row after matching", envelope([row(), { ...row(8), startTime: "invalid" }])], ["too many rows", envelope(Array.from({ length: 501 }, (_, index) => row(index + 1)))],
  ])("rejects %s without partial AVAILABLE or fabricated EMPTY", (_name, value) => { expect(() => normalize(value)).toThrow(); });
  it("rejects course-local DST gaps/folds, preserves fractional instant precision, and does not confuse sold holes with layout", () => {
    expect(() => cpsLocalInstant("2026-03-08T02:30:00", source.timeZone)).toThrow("CPS_SLOT_DATE_INVALID");
    expect(() => cpsLocalInstant("2026-11-01T01:30:00", source.timeZone)).toThrow("CPS_SLOT_DATE_INVALID");
    expect(cpsLocalInstant("2026-10-23T10:30:00.1234567", source.timeZone).toISOString()).toBe("2026-10-23T14:30:00.123Z");
    expect(normalize(envelope([{ ...row(), holes: 18 }]))[0].holes).toBe(18);
    expect(cpsAvailabilityQuery(input.date, [1], uuid).get("holes")).toBe("0");
  });
});

it("the actual pinned transport callback admits only the exact UUID request and no companion credentials", async () => {
  const url = source.bookingUrl.slice(0, -1) + CPS_API_PATH + "/RegisterTransactionId", headers = new Headers({ "content-type": "application/json", "x-apikey": "syntheticPublishedKey" });
  let dns = 0, wire = 0;
  const fetch = createAddressPinnedPublicFetchTransport({ parseUrl: value => new URL(value), maxResponseBytes: 100, timeoutMs: 1000, redirectLimit: 0,
    authorizeReadPost: (target, actual, body) => cpsBootstrapReadAllowed(target, actual, body, { url, headers, transactionId: uuid }) }, {
    resolveAddresses: async () => { dns++; return [{ address: "8.8.8.8", family: 4 }]; },
    requestPinned: async () => { wire++; return json(true); },
  });
  expect((await fetch(url, { method: "POST", headers, body: JSON.stringify({ transactionId: uuid }) })).status).toBe(200);
  for (const [target, requestHeaders, body] of [[url.replace("RegisterTransactionId", "LockTeeTimes"), headers, JSON.stringify({ transactionId: uuid })],
    [url, headers, JSON.stringify({ transactionId: uuid, action: "homepage" })], [url, new Headers({ ...Object.fromEntries(headers), cookie: "not-imported" }), JSON.stringify({ transactionId: uuid })]] as const)
    await expect(fetch(target, { method: "POST", headers: requestHeaders, body })).rejects.toThrow();
  expect(dns).toBe(1); expect(wire).toBe(1);
});
