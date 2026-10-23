import { describe, expect, it, vi } from "vitest";
import { isSafePublicBootstrapReadUrl, isSafePublicMemberSportsEventsReadUrl } from "./public-bootstrap-read-url";
import { isSafeRecipeUrl } from "./recipe";

const url = "https://api.membersports.com/api/v1/Events/eventsByDateForCourses/golfClubId/12679/searchDate/2026-10-23?golfCourseIds=15654";
const accepts = (value = url, kind = "xhr", method = "GET") => isSafePublicBootstrapReadUrl(value, kind, method, isSafeRecipeUrl);

describe("observed public dated course events URL", () => {
  it("admits only the ancillary data role without changing customer URL validation or the wire URL", () => {
    expect(isSafeRecipeUrl(url)).toBe(false);
    expect(accepts()).toBe(true); expect(accepts(url, "fetch")).toBe(true);
    const strict = vi.fn(isSafeRecipeUrl), original = url;
    expect(isSafePublicBootstrapReadUrl(url, "xhr", "GET", strict)).toBe(true);
    expect(strict).toHaveBeenCalledExactlyOnceWith(url.replace("/eventsByDateForCourses/", "/public-course-events/"));
    expect(url).toBe(original); expect(isSafeRecipeUrl(url)).toBe(false);
  });
  it("retains strict callback rejection and exceptions", () => {
    expect(isSafePublicBootstrapReadUrl(url, "xhr", "GET", () => false)).toBe(false);
    expect(isSafePublicBootstrapReadUrl(url, "xhr", "GET", () => { throw Error("DENIED"); })).toBe(false);
  });
  it.each(["\n", "\r\n", "\t", " "])("rejects raw trailing whitespace before any permissive callback: %j", suffix => {
    expect(isSafePublicMemberSportsEventsReadUrl(url + suffix, "xhr", "GET", () => true)).toBe(false);
  });
  it.each(["HEAD", "OPTIONS", "POST", "PUT", "DELETE"])("does not authorize method %s", method => {
    expect(accepts(url, "fetch", method)).toBe(false);
  });
  it.each(["document", "script", "stylesheet", "image", "other", ""])("does not authorize resource %s", kind => {
    expect(accepts(url, kind)).toBe(false);
  });
  it.each([
    url.replace("https:", "http:"), url.replace("api.membersports.com", "API.membersports.com"),
    url.replace("api.membersports.com", "api.membersports.com:443"), url.replace("api.membersports.com", "x:pass@api.membersports.com"),
    url.replace("api.membersports.com", "api.membersports.com.evil.example"), url.replace("/Events/", "/events/"),
    url.replace("/Events/", "/Events/./"), url.replace("eventsByDateForCourses", "events%42yDateForCourses"),
    url.replace("eventsByDateForCourses", "eventByDateForCourses"), url.replace("/golfClubId/", "/golfclubid/"),
    url.replace("/searchDate/", "/SearchDate/"), url.replace("?", "/?"), url + "#private", " " + url, url + " ",
    url.replace("golfCourseIds=", "golfCourseIds%3D"), url.replace("golfCourseIds=", "%67olfCourseIds="),
    url.replace("golfCourseIds=", "golfCourseId="), url + "&golfCourseIds=15654", url + "&token=private",
    url + "&date=2026-10-23", url + "&", url.replace("?golfCourseIds=15654", ""),
    url.replace("=15654", "="), url.replace("=15654", "=15654,15655"), url.replace("=15654", "=%31%35%36%35%34"),
  ])("rejects nonliteral origins, paths and queries: %s", value => { expect(accepts(value)).toBe(false); });
  it.each(["0", "01", "-1", "1.5", "2147483648", "99999999999"])("rejects noncanonical or excessive public identifiers %s", value => {
    expect(accepts(url.replace("/12679/", `/${value}/`))).toBe(false);
    expect(accepts(url.replace("=15654", `=${value}`))).toBe(false);
  });
  it.each(["2026-02-29", "2026-04-31", "2026-13-23", "0000-10-23", "2026-1-23", "2026%2D10%2D23"])(
    "rejects invalid or aliased calendar date %s", value => { expect(accepts(url.replace("2026-10-23", value))).toBe(false); });
  it("accepts a real leap day and canonical INT32 edges without claiming provider maxima", () => {
    expect(accepts(url.replace("2026-10-23", "2028-02-29"))).toBe(true);
    expect(accepts(url.replace("/12679/", "/1/").replace("=15654", "=2147483647"))).toBe(true);
  });
});
