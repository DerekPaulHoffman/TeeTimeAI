// @vitest-environment node
import { describe, expect, it } from "vitest";
import observed from "./fixtures/mindbody-public-day-form-observed.json";
import { adjacentMindbodyDay, createMindbodyPublicDayFormIntent, mindbodyCivilToDisplayedDate } from "./mindbody-public-form-read";
const body = (date = observed.observedNextDate) => {
  const fields = new URLSearchParams(observed.fields.map(row => [row.name, row.value])); fields.set("txtDate", mindbodyCivilToDisplayedDate(date)); return fields.toString();
};
const mint = (value: string, changes: Partial<Parameters<typeof createMindbodyPublicDayFormIntent>[0]> = {}) => createMindbodyPublicDayFormIntent({
  sourceUrl: observed.sourceUrl, targetUrl: observed.targetUrl, body: value, currentDate: observed.currentDate,
  direction: 1, deadlineAt: Date.now() + 1000, sourceCurrent: () => true, ...changes,
});
describe("exact observed public Mindbody search2 day form", () => {
  it("changes only the adjacent displayed day among the actual11 observed fields", () => {
    expect(observed.fields).toHaveLength(11); const value = mint(body());
    expect(value.matches(body(), "application/x-www-form-urlencoded")).toBe(true); expect(value.consume()).toBe(true); expect(value.consume()).toBe(false);
    expect(JSON.stringify(value)).not.toContain("SYNTHETIC_CSRF_TOKEN");
  });
  it.each(observed.fields.map(row => row.name))("rejects missing or duplicate %s", key => {
    const missing = new URLSearchParams(body()); missing.delete(key); expect(() => mint(missing.toString())).toThrow("MINDBODY_PUBLIC_DAY_REJECTED");
    const duplicate = new URLSearchParams(body()); duplicate.append(key, duplicate.get(key)!); expect(() => mint(duplicate.toString())).toThrow("MINDBODY_PUBLIC_DAY_REJECTED");
  });
  it.each([["requiredtxtUserName", "user"], ["requiredtxtPassword", "password"], ["optForwardingLink", "https://example.org/"], ["optRememberMe", "1"],
    ["pageNum", "2"], ["tabID", "2"], ["optTG", "2"], ["optInstructor", "100000001"], ["optView", "week"], ["route", "extra"], ["CSRFToken", ""]])(
    "rejects non-display/unknown routing %s", (key, value) => { const fields = new URLSearchParams(body()); fields.set(key, value); expect(() => mint(fields.toString())).toThrow("MINDBODY_PUBLIC_DAY_REJECTED"); });
  it.each(["2026-10-23", "2026-10-25", "2026-10-22"])("rejects a nonadjacent/wrong direction date %s", date => { expect(() => mint(body(date))).toThrow("MINDBODY_PUBLIC_DAY_REJECTED"); });
  it.each([["2026-01-31", 1, "2026-02-01"], ["2028-02-28", 1, "2028-02-29"], ["2028-03-01", -1, "2028-02-29"],
    ["2026-03-07", 1, "2026-03-08"], ["2026-11-01", 1, "2026-11-02"], ["2027-01-01", -1, "2026-12-31"]] as const)(
    "uses civil days across month/leap/DST/year boundaries %s", (from, direction, next) => {
      expect(adjacentMindbodyDay(from, direction)).toBe(next); expect(() => mint(body(next), { currentDate: from, direction })).not.toThrow();
    });
  it("rejects invalid civil dates, source/action aliases and stale documents", () => {
    expect(() => adjacentMindbodyDay("2026-02-30", 1)).toThrow(); expect(() => adjacentMindbodyDay("2026-01-01", 0 as 1)).toThrow();
    for (const sourceUrl of [observed.sourceUrl + "&token=private", observed.sourceUrl.replace("main_appts.asp", "appt_req.asp"), "https://foreign.example/ASP/main_appts.asp"])
      expect(() => mint(body(), { sourceUrl })).toThrow("MINDBODY_PUBLIC_DAY_REJECTED");
    for (const targetUrl of [observed.targetUrl + "?load=sched", observed.targetUrl.replace("main_appts.asp", "login_p.asp")])
      expect(() => mint(body(), { targetUrl })).toThrow("MINDBODY_PUBLIC_DAY_REJECTED");
    expect(() => mint(body(), { sourceCurrent: () => false })).toThrow("MINDBODY_PUBLIC_DAY_REJECTED");
  });
});
