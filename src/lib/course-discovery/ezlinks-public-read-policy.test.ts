import { describe, expect, it } from "vitest";
import { createEzLinksPublicReadPolicy, isEzLinksProviderUrl } from "./ezlinks-public-read-policy";

const origin = "https://public-course.ezlinksgolf.com";
const initial = () => ({ MasterSponsorID: "1234", AllCourseIDs: "11,22", Courses: [{ CourseID: 11 }, { CourseID: 22 }],
  SearchMinDate: "2030-10-21T17:51:21.03", SearchMaxDate: "2030-11-04T17:51:21.03", StartTimeSet: "05:00:00", EndTimeSet: "19:00:00",
  NumPlayersList: ["1", "2", "3", "4"], HolesList: ["Any", "18", "9"] });
const listing = () => ({ p01: [11], p02: "10/23/2030", p03: "8:00 AM", p04: "6:00 PM", p05: 0, p06: 2, p07: false });
const headers = () => new Headers({ "content-type": "application/json;charset=utf-8", origin });
const url = (path = "search") => new URL(`${origin}/api/search/${path}`);
function bound(now?: () => number) {
  const policy = createEzLinksPublicReadPolicy({ now });
  const token = policy.observeDocument(`${origin}/search`, 200);
  expect(policy.observeResponse(url("init"), "GET", 200, "application/json; charset=utf-8", initial(), token)).toBe(true);
  return { policy, token, allows: (value: unknown = listing()) => policy.allows(url(), headers(), JSON.stringify(value)) };
}

describe("source-bound EZLinks public read POST policy", () => {
  it.each(["/", "/search", "/index.html"])("binds an actual200 public %s document and init response", path => {
    const policy = createEzLinksPublicReadPolicy();
    const token = policy.observeDocument(origin + path, 200);
    expect(token).toBeDefined(); expect(policy.currentDocument()).toBe(token);
    expect(policy.observeResponse(url("init"), "GET", 200, "application/json", JSON.stringify(initial()), token)).toBe(true);
    expect(policy.allows(url("gsahs"), headers(), '{"sponsorId":1234}')).toBe(true);
    expect(policy.allows(url(), headers(), JSON.stringify(listing()))).toBe(true);
  });
  it.each(["a", "a-b", `a${"b".repeat(61)}1`])("accepts a standard bounded tenant label%s", tenant => {
    expect(createEzLinksPublicReadPolicy().observeDocument(`https://${tenant}.ezlinksgolf.com/search`, 200)).toBeDefined();
  });
  it("requires observed document plus init, not a URL or model-supplied configuration", () => {
    const policy = createEzLinksPublicReadPolicy();
    expect(policy.allows(url(), headers(), JSON.stringify(listing()))).toBe(false);
    expect(policy.observeResponse(url("init"), "GET", 200, "application/json", initial(), undefined)).toBe(false);
    policy.observeDocument(`${origin}/search`, 200);
    expect(policy.allows(url(), headers(), JSON.stringify(listing()))).toBe(false);
  });
  it.each([
    "https://ezlinksgolf.com/search", "https://api.ezlinksgolf.com/search", "https://admin.ezlinksgolf.com/search",
    "https://auth.ezlinksgolf.com/search", "https://members.ezlinksgolf.com/search", "https://a.b.ezlinksgolf.com/search",
    "https://public-course-.ezlinksgolf.com/search", "https://-public-course.ezlinksgolf.com/search",
    `https://a${"b".repeat(63)}.ezlinksgolf.com/search`,
    "https://public-course.ezlinksgolf.com.attacker.example/search", "http://public-course.ezlinksgolf.com/search",
    `${origin}:8443/search`, "https://user:secret@public-course.ezlinksgolf.com/search", `${origin}/api/search/init`,
    `${origin}/account`, `${origin}/search?token=secret`, `${origin}/search#account`, `${origin}/%73earch`,
  ])("does not observe unsafe or nonpublic document %s", document => {
    const policy = createEzLinksPublicReadPolicy(); expect(policy.observeDocument(document, 200)).toBeUndefined();
  });
  it.each([201, 204, 206, 301, 403, 500])("does not observe document status%s", status => {
    expect(createEzLinksPublicReadPolicy().observeDocument(`${origin}/search`, status)).toBeUndefined();
  });
  it("invalidates scope on navigation and cannot borrow a prior or foreign document token", () => {
    const { policy, token, allows } = bound();
    const nextToken = policy.observeDocument(`${origin}/search`, 200);
    expect(nextToken).not.toBe(token); expect(allows()).toBe(false);
    expect(policy.observeResponse(url("init"), "GET", 200, "application/json", initial(), token)).toBe(false);
    const foreign = createEzLinksPublicReadPolicy().observeDocument(`${origin}/search`, 200);
    expect(policy.observeResponse(url("init"), "GET", 200, "application/json", initial(), foreign)).toBe(false);
    expect(policy.observeResponse(url("init"), "GET", 200, "application/json", initial(), nextToken)).toBe(true);
    expect(allows()).toBe(true);
    policy.observeDocument("https://another-course.ezlinksgolf.com/search", 200);
    expect(allows()).toBe(false);
    policy.observeDocument("https://official.example.org/", 200);
    expect(policy.currentDocument()).toBeUndefined();
  });
  it("expires init scope after five minutes and rejects backwards clock readings", () => {
    let time = 1_000; const { policy, token, allows } = bound(() => time);
    time += 300_000; expect(allows()).toBe(true);
    time++; expect(allows()).toBe(false);
    expect(policy.observeResponse(url("init"), "GET", 200, "application/json", initial(), token)).toBe(true);
    expect(allows()).toBe(true); time = 0; expect(allows()).toBe(false);
  });
  it.each([
    ["POST", 200, "application/json"], ["GET", 206, "application/json"], ["GET", 403, "application/json"],
    ["GET", 200, "text/html"], ["GET", 200, "application/jsonp"],
  ] as const)("rejects init method/status/type%s/%s/%s and clears prior scope", (method, status, type) => {
    const { policy, token, allows } = bound();
    expect(policy.observeResponse(url("init"), method, status, type, initial(), token)).toBe(false); expect(allows()).toBe(false);
  });
  it.each([
    { MasterSponsorID: 1234 }, { MasterSponsorID: "0" }, { Courses: [{ CourseID: "11" }] }, { Courses: [{ CourseID: 11 }, { CourseID: 11 }] },
    { Courses: [] }, { AllCourseIDs: "11,99" }, { AllCourseIDs: "11,11" }, { AllCourseIDs: "11, 22" },
    { NumPlayersList: ["1", "5"] }, { NumPlayersList: [1, 2] }, { NumPlayersList: ["1", "1"] },
    { HolesList: ["Any", "27"] }, { HolesList: ["Any", 18] }, { HolesList: ["Any", "Any"] },
    { SearchMinDate: "2030-02-30T10:00:00" }, { SearchMaxDate: "2030-10-20T10:00:00" },
    { SearchMaxDate: "2032-10-21T10:00:00" }, { StartTimeSet: "19:00:00", EndTimeSet: "05:00:00" },
    { EndTimeSet: "24:00:00" },
  ])("rejects malformed or ambiguous public init fields", fields => {
    const { policy, token, allows } = bound();
    expect(policy.observeResponse(url("init"), "GET", 200, "application/json", { ...initial(), ...fields }, token)).toBe(false);
    expect(allows()).toBe(false);
  });
  it("rejects queried init and ignores foreign responses without borrowing identity", () => {
    const { policy, token, allows } = bound();
    expect(policy.observeResponse(new URL("https://other-course.ezlinksgolf.com/api/search/init"), "GET", 200, "application/json", initial(), token)).toBe(false);
    expect(policy.observeResponse(new URL(`${url("init")}?tenant=other`), "GET", 200, "application/json", initial(), token)).toBe(false);
    expect(allows()).toBe(false);
  });
  it.each([{}, { sponsorId: 999 }, { sponsorId: "1234" }, { sponsorId: 1234, query: "{read}" }, { sponsorId: 1234, token: "secret" }])(
    "rejects altered or extended settings bodies", value => {
      const { policy } = bound(); expect(policy.allows(url("gsahs"), headers(), JSON.stringify(value))).toBe(false);
    });
  it.each([true, null, 0, "false", undefined])("never authorizes hold flag%s", p07 => {
    expect(bound().allows({ ...listing(), p07 })).toBe(false);
  });
  it.each([
    { p01: [] }, { p01: [99] }, { p01: [11, 11] }, { p01: ["11"] }, { p01: [11.5] },
    { p02: "2030-10-23" }, { p02: "02/30/2030" }, { p02: "10/20/2030" }, { p02: "11/05/2030" },
    { p03: "4:59 AM" }, { p03: "7:00 PM", p04: "6:00 PM" }, { p04: "7:01 PM" }, { p03: "08:00:01" }, { p04: "25:00" },
    { p03: "08:00" }, { p04: "18:00" }, { p03: "08:00 AM" }, { p03: "8:00 am" }, { p03: "8:00AM" },
    { p03: "12:00 AM" }, { p04: "0:00 PM" },
    { p05: "0" }, { p05: -1 }, { p05: 3 }, { p05: 9 }, { p05: 18 }, { p06: 0 }, { p06: 5 }, { p06: "2" },
    { query: "{read}" }, { SessionID: "secret" }, { email: "private@example.org" }, { p07: false, reserve: true },
  ])("rejects foreign IDs, unverified values or transaction-shaped additions", fields => {
    expect(bound().allows({ ...listing(), ...fields })).toBe(false);
  });
  it.each([{ p01: [11] }, { p01: [22] }, { p01: [11, 22] }])("allows only verified unique course subsets%s", ({ p01 }) => {
    expect(bound().allows({ ...listing(), p01 })).toBe(true);
  });
  it.each([0, 1, 2])("uses a verified HolesList index%s without claiming physical layout", p05 => {
    expect(bound().allows({ ...listing(), p05 })).toBe(true);
  });
  it.each(["10/21/2030", "11/04/2030"])("allows inclusive source date bound%s", p02 => {
    expect(bound().allows({ ...listing(), p02, p03: "5:00 AM", p04: "7:00 PM" })).toBe(true);
  });
  it("uses the proven hourMinFilter noon/midnight spelling without extending to a24:00end", () => {
    const { policy, token } = bound();
    expect(policy.observeResponse(url("init"), "GET", 200, "application/json", { ...initial(), StartTimeSet: "00:00:00", EndTimeSet: "23:59:00" }, token)).toBe(true);
    expect(policy.allows(url(), headers(), JSON.stringify({ ...listing(), p03: "0:00 AM", p04: "12:00 PM" }))).toBe(true);
    expect(policy.allows(url(), headers(), JSON.stringify({ ...listing(), p03: "12:00 PM", p04: "11:59 PM" }))).toBe(true);
  });
  it.each(["/api/search/reservation", "/api/search/reset", "/api/account/update", "/api/search/search/", "/api/search/search?x=1"])(
    "does not permit other operations%s", path => {
      const { policy } = bound(); expect(policy.allows(new URL(origin + path), headers(), JSON.stringify(listing()))).toBe(false);
    });
  it.each(["authorization", "cookie", "x-api-key", "x-auth-token", "next-action", "x-csrf-token", "session"])("denies credential/intent header%s", name => {
    const { policy } = bound(), withSecret = headers(); withSecret.set(name, "secret");
    expect(policy.allows(url(), withSecret, JSON.stringify(listing()))).toBe(false);
  });
  it("rejects duplicate body keys, foreign origin, wrong content type and oversized bodies", () => {
    const { policy } = bound();
    expect(policy.allows(url("gsahs"), headers(), '{"sponsorId":999,"sponsorId":1234}')).toBe(false);
    expect(policy.allows(url(), headers(), JSON.stringify(listing()).replace('"p07":false', '"p07":true,"p07":false'))).toBe(false);
    const changed = headers(); changed.set("origin", "https://foreign.example.org");
    expect(policy.allows(url(), changed, JSON.stringify(listing()))).toBe(false);
    changed.set("origin", origin); changed.set("content-type", "text/plain");
    expect(policy.allows(url(), changed, JSON.stringify(listing()))).toBe(false);
    expect(policy.allows(url(), headers(), " ".repeat(2_049) + JSON.stringify(listing()))).toBe(false);
  });
});

describe("provider namespace bypass protection", () => {
  it.each(["https://ezlinksgolf.com/", "https://api.ezlinksgolf.com/private", "https://admin.ezlinksgolf.com/",
    "https://a.b.ezlinksgolf.com/graphql", "https://public-course.ezlinksgolf.com./"])("recognizes even denied provider URL%s", value => {
    expect(isEzLinksProviderUrl(value)).toBe(true); expect(createEzLinksPublicReadPolicy().handles(value)).toBe(true);
  });
  it.each(["https://ezlinksgolf.com.attacker.example/", "https://fakeezlinksgolf.com/", "invalid"])("does not misidentify%s", value => {
    expect(isEzLinksProviderUrl(value)).toBe(false);
  });
});
