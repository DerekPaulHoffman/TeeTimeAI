// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CPS_API_PATH, CPS_PUBLIC_BUILD, cpsMetadataSchema, inspectCpsOfficialDocument, parseCpsCatalog,
  parseCpsConfiguration, parseCpsOptions, parseCpsSource, validateCpsIdentity } from "./cps-source";

const source = { officialUrl: "https://www.thebobgc.com/", bookingUrl: "https://thebobgcpa.cps.golf/",
  venueName: "Bob O'Connor Golf Course", venueAddress: "5370 Schenley Dr, Pittsburgh, PA 15217, USA", timeZone: "America/New_York" };
const footer = "<footer>© 2022 Bob O'Connor Golf Course | 5370 Schenley Drive | Pittsburgh, PA 15217 | Phone: 412.622.6959</footer>";
const page = (content: string) => `<html><body>${content}${footer}</body></html>`;
const configuration = () => ({ siteName: "thebobgcpa", onlineApi: "https://thebobgcpa.cps.golf" + CPS_API_PATH,
  authorityBaseUrl: "https://thebobgcpa.cps.golf/identityapi", clientId: "public-client", websiteId: "00000000-0000-0000-0000-000000000000",
  apiKey: "syntheticPublishedKey", buildNumber: CPS_PUBLIC_BUILD });
const options = () => ({ webSiteId: "public-site", courseOptions: [{ courseId: 1, courseName: source.venueName, webSiteId: "public-site" }], reservationOptions: { terminalId: 1 } });
const courses = () => [{ courseId: 1, courseName: source.venueName, timezoneId: source.timeZone, websiteId: "public-site", active: true as const, holes: 9 as const }];

describe("CPS stable public source", () => {
  it("accepts only an exact public tenant document, never API/account/query/credential sources", () => {
    expect(parseCpsSource(source.bookingUrl)?.tenant).toBe("thebobgcpa");
    expect(parseCpsSource(source.bookingUrl + "onlineresweb/search-teetime")?.tenant).toBe("thebobgcpa");
    for (const value of ["http://thebobgcpa.cps.golf/", "https://user:private@thebobgcpa.cps.golf/", "https://thebobgcpa.cps.golf:8443/",
      "https://admin.cps.golf/", "https://thebobgcpa.cps.golf/?key=x", "https://thebobgcpa.cps.golf/#x", "https://thebobgcpa.cps.golf/identityapi",
      "https://nested.thebobgcpa.cps.golf/", "https://thebobgcpa.cps.golf" + CPS_API_PATH + "/TeeTimes"])
      expect(parseCpsSource(value)).toBeUndefined();
  });
  it("replays the retained Bob footer and observed tee-times links then exact titled iframe", () => {
    expect(inspectCpsOfficialDocument(page('<a href="/teetimes">BOOK A TEE TIME</a><a href="/teetimes">Tee Times</a>'), source.officialUrl, source))
      .toEqual({ bookingLinked: false, nextUrls: ["https://www.thebobgc.com/teetimes"] });
    expect(inspectCpsOfficialDocument(page('<a href="/teetimes">BOOK A TEE TIME</a><a href="/bookteetimes">Tee time reservations</a><a href="/teetimes">Tee Times</a>'), source.officialUrl, source))
      .toEqual({ bookingLinked: false, nextUrls: ["https://www.thebobgc.com/teetimes", "https://www.thebobgc.com/bookteetimes"] });
    expect(inspectCpsOfficialDocument(page(`<h1>Book a Tee Time</h1><iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>`),
      "https://www.thebobgc.com/bookteetimes", source)).toEqual({ bookingLinked: true });
  });
  it("retains the full observed public decimal-hour search link and requires that exact official outlink", () => {
    const bookingUrl = "https://thebobgcpa.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0&TeeOffTimeMax=23.999722222222225";
    expect(parseCpsSource(bookingUrl)).toEqual({ bookingUrl, origin: "https://thebobgcpa.cps.golf", tenant: "thebobgcpa" });
    expect(() => validateCpsIdentity({ ...source, bookingUrl })).not.toThrow();
    const html = page(`<a href="${bookingUrl}">Book a Tee Time</a>`);
    expect(inspectCpsOfficialDocument(html, source.officialUrl, { ...source, bookingUrl })).toEqual({ bookingLinked: true });
    expect(() => inspectCpsOfficialDocument(html, source.officialUrl, { ...source, bookingUrl: bookingUrl.split("?")[0] })).toThrow("OFFICIAL_BOOKING_SOURCE_MISMATCH");
    expect(() => inspectCpsOfficialDocument(html, source.officialUrl, { ...source, bookingUrl: bookingUrl.replace("Min=0", "Min=1") })).toThrow("OFFICIAL_BOOKING_SOURCE_MISMATCH");
  });
  it.each(["TeeOffTimeMin=0", "TeeOffTimeMin=0&TeeOffTimeMin=1", "TeeOffTimeMin=0&TeeOffTimeMax=24", "TeeOffTimeMin=2&TeeOffTimeMax=1",
    "TeeOffTimeMin=-1&TeeOffTimeMax=23", "TeeOffTimeMin=NaN&TeeOffTimeMax=23", "TeeOffTimeMin=0&TeeOffTimeMax=1e1", "TeeOffTimeMin=0&TeeOffTimeMax=Infinity",
    "TeeOffTimeMin=0&TeeOffTimeMax=23&account=1", "TeeOffTimeMin=0&token=private", "teeofftimemin=0&TeeOffTimeMax=23", "TeeOffTimeMin=%30&TeeOffTimeMax=23",
    "TeeOffTimeMin=0&TeeOffTimeMax=23.1234567890123456", "TeeOffTimeMin=0&TeeOffTimeMax=23#changed"])("rejects unobserved/ambiguous query grammar: %s", query => {
    expect(parseCpsSource(`https://thebobgcpa.cps.golf/onlineresweb/search-teetime?${query}`)).toBeUndefined();
  });
  it("does not extend query permission to official identities, root pages, APIs or transactions", () => {
    const query = "?TeeOffTimeMin=0&TeeOffTimeMax=23";
    for (const path of ["/", CPS_API_PATH + "/TeeTimes", "/onlineresweb/checkout"])
      expect(parseCpsSource(`https://thebobgcpa.cps.golf${path}${query}`)).toBeUndefined();
    expect(() => validateCpsIdentity({ ...source, officialUrl: source.officialUrl + query })).toThrow();
  });
  it.each([
    ["wrong venue", page(`<iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>`).replaceAll("Bob O'Connor", "Another Venue")],
    ["wrong number", page(`<iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>`).replace("5370", "5371")],
    ["wrong ZIP", page(`<iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe>`).replace("15217", "15218")],
    ["foreign tenant", page('<iframe src="https://another.cps.golf/" title="Book a Tee Time"></iframe>')],
    ["multiple tenants", page(`<iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe><a href="https://another.cps.golf/">Tee Times</a>`)],
    ["hidden iframe", page(`<div hidden><iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe></div>`)],
    ["srcdoc", page(`<iframe src="${source.bookingUrl}" srcdoc="ignored" title="Book a Tee Time"></iframe>`)],
    ["unlabelled iframe", page(`<iframe src="${source.bookingUrl}"></iframe>`)],
    ["too many booking pages", page('<a href="/teetimes">Tee Times</a><a href="/different">Book a Tee Time</a><a href="/third">Tee Times</a>')],
    ["script identity", `<body><script>${footer}</script><iframe src="${source.bookingUrl}" title="Book a Tee Time"></iframe></body>`],
  ])("rejects %s without promoting a guessed booking route", (_name, html) => {
    expect(() => inspectCpsOfficialDocument(html, source.officialUrl, source)).toThrow();
  });
  it("requires complete canonical identity and IANA context", () => {
    for (const value of [{ ...source, venueAddress: undefined }, { ...source, venueAddress: "Pittsburgh PA" },
      { ...source, timeZone: "Not/AZone" }, { ...source, officialUrl: "http://www.thebobgc.com/" }]) expect(() => validateCpsIdentity(value)).toThrow();
  });
  it("binds fresh configuration, whole catalog IDs/names, website and provider IANA without storing routing secrets", () => {
    const config = parseCpsConfiguration(configuration(), source), selected = parseCpsOptions(options(), config);
    const metadata = parseCpsCatalog(courses(), selected, source);
    expect(metadata).toMatchObject({ family: "CPS", tenant: "thebobgcpa", courseIds: [1] });
    expect(JSON.stringify(metadata)).not.toMatch(/syntheticPublished|public-site|public-client|terminal|transaction/iu);
    expect(Object.keys(metadata).sort()).toEqual(["catalogHash", "courseIds", "family", "tenant"]);
    expect(() => cpsMetadataSchema.parse({ ...metadata, apiKey: "not-durable" })).toThrow();
    for (const data of [{ ...configuration(), siteName: "foreign" }, { ...configuration(), onlineApi: "https://foreign.cps.golf" + CPS_API_PATH },
      { ...configuration(), authorityBaseUrl: "https://foreign.cps.golf/identityapi" }, { ...configuration(), buildNumber: "future-unreviewed" }])
      expect(() => parseCpsConfiguration(data, source)).toThrow();
    for (const data of [{ ...options(), webSiteId: "foreign" }, { ...options(), courseOptions: [...options().courseOptions, ...options().courseOptions] }])
      expect(() => parseCpsOptions(data, config)).toThrow();
  });
  it("accepts only the exact reviewed current public client build after existing whitespace normalization", () => {
    expect(parseCpsConfiguration({ ...configuration(), buildNumber: "\ufeff26.3.0.34794395074\n" }, source).buildNumber).toBe("26.3.0.34794395074");
    for (const buildNumber of ["99.1.2.12345678901", "99.2.3.42"])
      expect(() => parseCpsConfiguration({ ...configuration(), buildNumber }, source)).toThrow("CPS_PUBLIC_BUILD_UNSUPPORTED");
    for (const buildNumber of ["99.1", "99.1.2.12345678901extra"])
      expect(() => parseCpsConfiguration({ ...configuration(), buildNumber }, source)).toThrow("CPS_CONFIGURATION_UNVERIFIED");
    expect(() => parseCpsConfiguration({ ...configuration(), buildNumber: "26.3.0.34794395074", siteName: "another" }, source)).toThrow();
    expect(parseCpsConfiguration({ ...configuration(), apiKey: undefined, buildNumber: "26.3.0.34794395074" }, source).apiKey).toBeUndefined();
    expect(() => parseCpsConfiguration({ ...configuration(), apiKey: undefined }, source)).toThrow("CPS_CONFIGURATION_UNVERIFIED");
  });
  it.each(["99.1.2.12345678901", "\ufeff99.1.2.12345678901\n"])("classifies a bound unsupported public build without deriving version-specific configuration: %s", buildNumber => {
    const current = { officialUrl: "https://public-course.example/", bookingUrl: "https://public-course.cps.golf/",
      venueName: "Public Golf Course", venueAddress: "10 Public Road, Example, NY 12345, USA", timeZone: "America/New_York" };
    const core = { siteName: "public-course", onlineApi: "https://public-course.cps.golf" + CPS_API_PATH,
      authorityBaseUrl: "https://public-course.cps.golf/identityapi", buildNumber };
    // Unknown protocols cannot borrow client IDs, keys or website routing from a reviewed version.
    expect(() => parseCpsConfiguration(core, current)).toThrow("CPS_PUBLIC_BUILD_UNSUPPORTED");
    expect(() => parseCpsConfiguration({ ...core, clientId: "synthetic-public-client", websiteId: "synthetic-site", apiKey: "synthetic-public-key" }, current))
      .toThrow("CPS_PUBLIC_BUILD_UNSUPPORTED");
  });
  it.each([
    { siteName: "foreign-course" }, { siteName: undefined }, { siteName: "public-course\u0000" },
    { onlineApi: "https://foreign-course.cps.golf" + CPS_API_PATH }, { onlineApi: undefined },
    { onlineApi: "https://public-course.cps.golf/another-api" }, { onlineApi: "https://public-course.cps.golf\u0000" + CPS_API_PATH },
    { authorityBaseUrl: "https://foreign-course.cps.golf/identityapi" }, { authorityBaseUrl: undefined },
    { authorityBaseUrl: "https://public-course.cps.golf/account" },
    { buildNumber: undefined }, { buildNumber: null }, { buildNumber: 99 }, { buildNumber: "" },
    { buildNumber: "99.1.2" }, { buildNumber: "099.1.2.3" }, { buildNumber: "99.1.2.3extra" },
    { buildNumber: "99.1.2.3\u0000" }, { buildNumber: "99.1.\n2.3" },
    { buildNumber: "99.1.2." + "1".repeat(21) }, { buildNumber: " ".repeat(65) + "99.1.2.3" },
  ])("keeps malformed or mismatched unsupported public build core as configuration failure: %j", changed => {
    const current = { officialUrl: "https://public-course.example/", bookingUrl: "https://public-course.cps.golf/",
      venueName: "Public Golf Course", venueAddress: "10 Public Road, Example, NY 12345, USA", timeZone: "America/New_York" };
    const value = { siteName: "public-course", onlineApi: "https://public-course.cps.golf" + CPS_API_PATH,
      authorityBaseUrl: "https://public-course.cps.golf/identityapi", buildNumber: "99.1.2.12345678901",
      clientId: "synthetic-public-client", websiteId: "synthetic-site", apiKey: "synthetic-public-key", ...changed };
    expect(() => parseCpsConfiguration(value, current)).toThrow("CPS_CONFIGURATION_UNVERIFIED");
  });
  it("does not classify an unsafe source or invalid JSON shape as unsupported public build", () => {
    for (const value of [null, [], "99.1.2.3", { ...configuration(), buildNumber: "99.1.2.3" }])
      expect(() => parseCpsConfiguration(value, { ...source, bookingUrl: source.bookingUrl + "account" })).toThrow("CPS_CONFIGURATION_UNVERIFIED");
  });
  it.each([CPS_PUBLIC_BUILD, "26.3.0.34794395074"])("retains required version-specific fields for reviewed build %s", buildNumber => {
    const value = { ...configuration(), buildNumber };
    expect(parseCpsConfiguration(value, source).buildNumber).toBe(buildNumber);
    for (const missing of [{ ...value, clientId: undefined }, { ...value, websiteId: undefined }])
      expect(() => parseCpsConfiguration(missing, source)).toThrow("CPS_CONFIGURATION_UNVERIFIED");
    if (buildNumber === CPS_PUBLIC_BUILD) expect(() => parseCpsConfiguration({ ...value, apiKey: undefined }, source)).toThrow("CPS_CONFIGURATION_UNVERIFIED");
    else expect(parseCpsConfiguration({ ...value, apiKey: undefined }, source).apiKey).toBeUndefined();
  });
  it.each(["name", "timezoneId", "websiteId", "active", "duplicate", "missing", "unknown course"])("rejects changed whole-catalog %s", kind => {
    const rows: unknown[] = courses();
    if (kind === "duplicate") rows.push(...courses());
    else if (kind === "missing") rows.length = 0;
    else rows[0] = { ...courses()[0], ...(kind === "name" ? { courseName: "Another Golf Course" } : kind === "unknown course" ? { courseId: 2 } :
      kind === "active" ? { active: false } : { [kind]: "foreign" }) };
    expect(() => parseCpsCatalog(rows, parseCpsOptions(options(), parseCpsConfiguration(configuration(), source)), source)).toThrow();
  });
});
