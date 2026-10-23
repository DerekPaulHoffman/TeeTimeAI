// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMindbodyPublicFormIntent, isMindbodyPublicSearchDocument } from "./mindbody-public-form-read";
import categoryObserved from "./fixtures/mindbody-public-category-form-observed.json";
const source = "https://clients.mindbodyonline.com/ASP/adm/adm_appt_search.asp?studioid=685163&lvl=&catid=&prodid=&date=10%2F23%2F2026&classid=0&stype=%2D9&loc=1&tg=&vt=&justloggedin=&pMode=0&view=&sSU=&qParam=&trn=0&page=&prodGroupId=&optForwardingLink=&nLgIn=";
const target = "https://clients.mindbodyonline.com/ASP/adm/adm_appt_search.asp?reSchedule=", contentType = "application/x-www-form-urlencoded";
// Exact captured public field contract with a synthetic private CSRF value.
export const mindbodySyntheticPublicFormBody = () => new URLSearchParams([
  ["CSRFToken", "synthetic-private-csrf"], ["frmApptRefNo", ""], ["frmTabID", "9"], ["alertGen", ""], ["scrollTop", "0"], ["origTrn", ""],
  ["origDate", ""], ["cType", ""], ["origId", ""], ["fromTabby", ""], ["optLoc", "1"], ["optTG", "2"], ["optVT", "5"], ["optTrnID", ""],
  ...Array.from({ length: 7 }, (_, i): [string, string] => ["optDay" + (i + 1), "on"]), ["optDates", "1"], ["optPreDateRange", ""], ["optDateRange", "0"],
  ["requiredtxtDateStart", "10/23/2026"], ["requiredtxtDateEnd", "10/23/2026"], ["optTimes", "0"], ["optTimeRange", "0"], ["optStartTime", "5:00:00 AM"], ["optEndTime", "5:00:00 AM"],
]).toString();
describe("controller-private Mindbody public form read intent", () => {
  it("accepts exact actual initial19-field category shape with seven empty hidden weekdays", () => {
    const body = new URLSearchParams(categoryObserved.fields.map(row => [row.name, row.value])).toString();
    expect(categoryObserved.fields).toHaveLength(19);
    const value = createMindbodyPublicFormIntent({ sourceUrl: categoryObserved.sourceUrl, targetUrl: categoryObserved.targetUrl, body,
      studioId: "685163", deadlineAt: Date.now() + 1000, sourceCurrent: () => true });
    expect(value.matches(body, contentType)).toBe(true); expect(value.consume()).toBe(true); expect(value.consume()).toBe(false);
    expect(JSON.stringify(value)).not.toContain("SYNTHETIC_CSRF_TOKEN");
  });
  it.each(["missing weekday", "duplicate category", "extra service", "extra date", "weekday on", "original appointment", "missing token", "private field", "wrong location"])(
    "rejects initial-category %s instead of filling or mixing form states", mode => {
      const fields = new URLSearchParams(categoryObserved.fields.map(row => [row.name, row.value]));
      if (mode === "missing weekday") fields.delete("optDay1"); if (mode === "duplicate category") fields.append("optTG", "2");
      if (mode === "extra service") fields.set("optVT", ""); if (mode === "extra date") fields.set("requiredtxtDateStart", "10/23/2026");
      if (mode === "weekday on") fields.set("optDay1", "on"); if (mode === "original appointment") fields.set("origId", "123");
      if (mode === "missing token") fields.delete("CSRFToken"); if (mode === "private field") fields.set("password", "private");
      if (mode === "wrong location") fields.set("optLoc", "2");
      expect(() => createMindbodyPublicFormIntent({ sourceUrl: categoryObserved.sourceUrl, targetUrl: categoryObserved.targetUrl,
        body: fields.toString(), studioId: "685163", deadlineAt: Date.now() + 1000, sourceCurrent: () => true })).toThrow("MINDBODY_PUBLIC_FORM_REJECTED");
    });
  it("accepts the actual first-category redirect without normalizing away public routing", () => {
    expect(isMindbodyPublicSearchDocument(source, "685163")).toBe(true); expect(isMindbodyPublicSearchDocument(source, "1")).toBe(false);
    expect(isMindbodyPublicSearchDocument(source + "&token=private")).toBe(false);
    expect(isMindbodyPublicSearchDocument(source.replace("justloggedin=", "justloggedin=1"))).toBe(false);
    expect(isMindbodyPublicSearchDocument(source.replace("nLgIn=", "nLgIn=1"))).toBe(false);
  });
  it("retains exact CSRF privately, permits one consumption and emits no body/proof fields", () => {
    const body = mindbodySyntheticPublicFormBody(), value = createMindbodyPublicFormIntent({ sourceUrl: source, targetUrl: target, body,
      studioId: "685163", deadlineAt: Date.now() + 1000, sourceCurrent: () => true });
    expect(value.matches(body, contentType)).toBe(true); expect(value.consume()).toBe(true); expect(value.sourceCurrent()).toBe(false);
    expect(value.consume()).toBe(false); expect(value.matches(body, contentType)).toBe(true);
    expect(JSON.stringify(value)).not.toMatch(/csrf|private|optVT|"body"/iu); value.revoke(); expect(value.matches(body, contentType)).toBe(false);
  });
  it.each(["CSRFToken", "optTG", "optVT", "optLoc", "requiredtxtDateStart"])("cannot relay a different %s than the observed form", key => {
    const body = mindbodySyntheticPublicFormBody(), value = createMindbodyPublicFormIntent({ sourceUrl: source, targetUrl: target, body,
      deadlineAt: Date.now() + 1000, sourceCurrent: () => true });
    const changed = new URLSearchParams(body); changed.set(key, key === "CSRFToken" ? "different-private-csrf" : "7");
    expect(value.matches(changed.toString(), contentType)).toBe(false);
  });
  it.each(["extra", "private", "duplicate", "reschedule", "nonempty original", "missing csrf", "unsafe path", "unsafe source", "wrong studio"])("rejects %s before mint", mode => {
    const fields = new URLSearchParams(mindbodySyntheticPublicFormBody());
    if (mode === "extra") fields.set("route", "public"); if (mode === "private") fields.set("password", "secret");
    if (mode === "duplicate") fields.append("optVT", "5"); if (mode === "reschedule") fields.set("frmApptRefNo", "123");
    if (mode === "nonempty original") fields.set("origId", "1"); if (mode === "missing csrf") fields.delete("CSRFToken");
    expect(() => createMindbodyPublicFormIntent({ sourceUrl: mode === "unsafe source" ? source.replace("https:", "http:") : source,
      targetUrl: mode === "unsafe path" ? target.replace("adm_appt_search.asp", "appt_req.asp") : target, body: fields.toString(),
      studioId: mode === "wrong studio" ? "1" : "685163", deadlineAt: Date.now() + 1000, sourceCurrent: () => true })).toThrow("MINDBODY_PUBLIC_FORM_REJECTED");
  });
  it("revokes changed or expired documents before consume and accepts no alternate encoding kind", () => {
    let current = true; const value = createMindbodyPublicFormIntent({ sourceUrl: source, targetUrl: target, body: mindbodySyntheticPublicFormBody(),
      deadlineAt: Date.now() + 1000, sourceCurrent: () => current }); current = false;
    expect(value.sourceCurrent()).toBe(false); expect(value.consume()).toBe(false); expect(value.matches(mindbodySyntheticPublicFormBody(), "application/json")).toBe(false);
    vi.useFakeTimers(); try { vi.advanceTimersByTime(2000); expect(value.active()).toBe(false); expect(value.consume()).toBe(false); }
    finally { vi.useRealTimers(); }
  });
});
