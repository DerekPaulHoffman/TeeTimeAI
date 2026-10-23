/** Private controller-only contract for the observed signed-out appointment
 * search form. It never authorizes a transaction, endpoint invention, or token
 * copied to headers/another transport. Bodies remain inside the owned browser. */
export type MindbodyPublicFormIntent = Readonly<{
  sourceUrl: string; targetUrl: string;
  sourceCurrent(): boolean; active(): boolean;
  matches(body: string, contentType: string): boolean;
  consume(): boolean; revoke(): void;
}>;
const origin = "https://clients.mindbodyonline.com";
const commonEmpty = ["frmApptRefNo", "alertGen", "origTrn", "origDate", "cType", "origId", "fromTabby"];
const empty = [...commonEmpty, "optPreDateRange"];
const days = Array.from({ length: 7 }, (_, i) => "optDay" + (i + 1));
// Initial category selection is a different observed public form state: it
// has exactly19 successful fields, hidden empty weekdays, and no service,
// resource, date or time controls. Never infer missing fields as defaults.
const categoryFields = new Set(["CSRFToken", ...commonEmpty, "frmTabID", "scrollTop", "optLoc", "optTG", ...days]);
const permitted = new Set(["CSRFToken", ...empty, "frmTabID", "scrollTop", "optLoc", "optTG", "optVT", "optTrnID",
  ...days, "optDates", "optDateRange", "requiredtxtDateStart", "requiredtxtDateEnd",
  "optTimes", "optTimeRange", "optStartTime", "optEndTime"]);
const dayFields = new Set(["CSRFToken", "pageNum", "requiredtxtUserName", "requiredtxtPassword", "optForwardingLink", "optRememberMe",
  "tabID", "txtDate", "optTG", "optInstructor", "optView"]);
export function isMindbodyPublicCalendarDocument(value: string) {
  try { const url = new URL(value); return url.href === value && url.origin === origin && !url.username && !url.password && !url.hash &&
    url.pathname === "/ASP/main_appts.asp" && ["", "?load=sched"].includes(url.search); } catch { return false; }
}
function validCivilDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value); if (!match) return;
  const date = new Date(value + "T00:00:00Z"); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : undefined;
}
export function adjacentMindbodyDay(currentDate: string, direction: -1 | 1) {
  const date = validCivilDate(currentDate); if (!date || ![-1, 1].includes(direction)) throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
  const next = new Date(date.getTime() + direction * 86_400_000); return next.toISOString().slice(0, 10);
}
export function mindbodyCivilToDisplayedDate(value: string) {
  const date = validCivilDate(value); if (!date) throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
  return (date.getUTCMonth() + 1) + "/" + date.getUTCDate() + "/" + date.getUTCFullYear();
}
function canonicalDayFields(body: string) {
  if (Buffer.byteLength(body) > 8192 || /[\r\n]/u.test(body)) return;
  const fields = new URLSearchParams(body), entries = [...fields];
  if (entries.length !== dayFields.size || new Set(entries.map(([key]) => key)).size !== entries.length ||
      entries.some(([key]) => !dayFields.has(key)) || body.split("&").some(part => !dayFields.has(part.split("=", 1)[0])) ||
      !/^[\x21-\x7e]{8,1024}$/u.test(fields.get("CSRFToken") ?? "") || fields.get("pageNum") !== "1" || fields.get("tabID") !== "9" ||
      fields.get("optTG") !== "0" || fields.get("optInstructor") !== "0" || fields.get("optView") !== "day" ||
      ["requiredtxtUserName", "requiredtxtPassword", "optForwardingLink", "optRememberMe"].some(key => fields.get(key) !== "")) return;
  return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
}
export function isMindbodyPublicSearchDocument(value: string, studioId?: string) {
  try {
    const url = new URL(value);
    if (url.href !== value || url.origin !== origin || url.username || url.password || url.hash ||
      !["/ASP/adm/adm_appt_search.asp", "/ASP/adm/adm_appt_search_p.asp"].includes(url.pathname)) return false;
    if (url.search === "" || url.search === "?reSchedule=") return true;
    const sourceKeys = ["studioid", "lvl", "catid", "prodid", "date", "classid", "stype", "loc", "tg", "vt", "justloggedin", "pMode", "view",
      "sSU", "qParam", "trn", "page", "prodGroupId", "optForwardingLink", "nLgIn"];
    if (url.searchParams.size !== sourceKeys.length || sourceKeys.some(key => url.searchParams.getAll(key).length !== 1) ||
        url.search.slice(1).split("&").some(part => !sourceKeys.includes(part.split("=", 1)[0]))) return false;
    const fixed = new Map([["classid", "0"], ["stype", "-9"], ["pMode", "0"], ["trn", "0"]]);
    return sourceKeys.every(key => key === "studioid" ? /^[1-9]\d{0,9}$/u.test(url.searchParams.get(key)!) && (!studioId || url.searchParams.get(key) === studioId) :
      key === "loc" ? /^[1-9]\d{0,9}$/u.test(url.searchParams.get(key)!) :
      key === "date" ? /^\d{1,2}\/\d{1,2}\/\d{4}$/u.test(url.searchParams.get(key)!) :
      url.searchParams.get(key) === (fixed.get(key) ?? ""));
  } catch { return false; }
}
function canonicalFields(body: string) {
  if (Buffer.byteLength(body) > 8192 || /[\r\n]/u.test(body)) return;
  const fields = new URLSearchParams(body), entries = [...fields];
  if (entries.length < categoryFields.size || entries.length > permitted.size || new Set(entries.map(([key]) => key)).size !== entries.length ||
      entries.some(([key]) => !permitted.has(key)) || body.split("&").some(part => !permitted.has(part.split("=", 1)[0]))) return;
  const get = (key: string) => fields.get(key);
  if (!get("CSRFToken") || !/^[\x21-\x7e]{8,1024}$/u.test(get("CSRFToken")!) || get("frmTabID") !== "9" || get("scrollTop") !== "0" ||
      commonEmpty.some(key => get(key) !== "") || !/^[1-9]\d{0,9}$/u.test(get("optLoc") ?? "") ||
      !/^[1-9]\d{0,9}$/u.test(get("optTG") ?? "")) return;
  const category = entries.length === categoryFields.size && entries.every(([key]) => categoryFields.has(key));
  if (category) {
    if (days.some(key => get(key) !== "")) return;
    return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
  }
  if (entries.length < 20 || empty.some(key => get(key) !== "") || !/^(?:|[1-9]\d{0,9})$/u.test(get("optVT") ?? "") ||
      !/^(?:|[1-9]\d{0,9})$/u.test(get("optTrnID") ?? "") || get("optDates") !== "1" || get("optDateRange") !== "0" ||
      get("optTimes") !== "0" || get("optTimeRange") !== "0" ||
      days.some(key => get(key) !== "on") ||
      ["requiredtxtDateStart", "requiredtxtDateEnd"].some(key => !/^\d{1,2}\/\d{1,2}\/\d{4}$/u.test(get(key) ?? "")) ||
      ["optStartTime", "optEndTime"].some(key => !/^(?:[1-9]|1[0-2]):[0-5]\d:00 [AP]M$/u.test(get(key) ?? ""))) return;
  return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
}
/** Minted only by fixed native capture code after reading the complete current
 * form. The exact ephemeral CSRF value participates in equality but is never
 * returned by this interface or placed in diagnostics. */
export function createMindbodyPublicFormIntent(input: { sourceUrl: string; targetUrl: string; body: string;
  deadlineAt: number; sourceCurrent: () => boolean; studioId?: string }): MindbodyPublicFormIntent {
  const canonical = canonicalFields(input.body);
  const sourceLocation = (() => { try { return new URL(input.sourceUrl).searchParams.get("loc"); } catch { return null; } })();
  if (!isMindbodyPublicSearchDocument(input.sourceUrl, input.studioId) || !isMindbodyPublicSearchDocument(input.targetUrl, input.studioId) ||
      new URL(input.sourceUrl).pathname !== new URL(input.targetUrl).pathname || !canonical ||
      sourceLocation !== null && new URLSearchParams(input.body).get("optLoc") !== sourceLocation ||
      !Number.isFinite(input.deadlineAt) || input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + 15_000 || !input.sourceCurrent())
    throw new Error("MINDBODY_PUBLIC_FORM_REJECTED");
  return privateIntent(input, canonical, canonicalFields);
}
/** Exact observed search2 display form. Only the adjacent civil day differs
 * from the complete current form; authentication fields must remain empty. */
export function createMindbodyPublicDayFormIntent(input: { sourceUrl: string; targetUrl: string; body: string; currentDate: string;
  direction: -1 | 1; deadlineAt: number; sourceCurrent: () => boolean }): MindbodyPublicFormIntent {
  const canonical = canonicalDayFields(input.body), next = adjacentMindbodyDay(input.currentDate, input.direction);
  if (!isMindbodyPublicCalendarDocument(input.sourceUrl) || input.targetUrl !== origin + "/ASP/main_appts.asp" || !canonical ||
      new URLSearchParams(input.body).get("txtDate") !== mindbodyCivilToDisplayedDate(next) ||
      !Number.isFinite(input.deadlineAt) || input.deadlineAt <= Date.now() || input.deadlineAt > Date.now() + 15_000 || !input.sourceCurrent())
    throw new Error("MINDBODY_PUBLIC_DAY_REJECTED");
  return privateIntent(input, canonical, canonicalDayFields);
}
function privateIntent(input: { sourceUrl: string; targetUrl: string; deadlineAt: number; sourceCurrent: () => boolean },
  canonical: string, read: (body: string) => string | undefined): MindbodyPublicFormIntent {
  let consumed = false, revoked = false;
  const active = () => !revoked && Date.now() < input.deadlineAt;
  return Object.freeze({ sourceUrl: input.sourceUrl, targetUrl: input.targetUrl, active,
    sourceCurrent: () => !consumed && active() && input.sourceCurrent(),
    matches: (body: string, contentType: string) => active() && /^application\/x-www-form-urlencoded(?:\s*;\s*charset=UTF-8)?$/iu.test(contentType) &&
      read(body) === canonical,
    consume: () => { if (consumed || !active() || !input.sourceCurrent()) return false; consumed = true; return true; },
    revoke: () => { revoked = true; },
  });
}
