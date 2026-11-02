import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";

export const chelseaPublicMetadataSchema = z.object({
  family: z.literal("CHELSEA"), protocol: z.literal("PUBLIC_BOOKING_ADMIN_V1"),
  courseCode: z.number().int().min(1).max(2147483647), courseLabel: z.string().trim().min(2).max(200),
  roundHoleCounts: z.array(z.union([z.literal(9), z.literal(18)])).min(1).max(2)
    .refine(values => values.every((v, i) => i === 0 || values[i - 1] < v)),
}).strict();
export type ChelseaPublicMetadata = z.infer<typeof chelseaPublicMetadataSchema>;
export function parseChelseaPublicSource(value: string) {
  try {
    const url = new URL(value), tenant = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.chelseareservations\.com$/u.exec(url.hostname)?.[1];
    if (!tenant || /^(?:www|admin|api|auth|login|member|private)$/u.test(tenant) || url.href !== value ||
        url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/golf/bookingadmin.aspx") return;
    return { url: url.href, origin: url.origin, tenant };
  } catch { return; }
}
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const element = (n: Node): n is Element => "tagName" in n;
const attribute = (n: Element, key: string) => n.attrs.find(a => a.name === key)?.value;
const clean = (v: string) => v.replace(/\s+/gu, " ").trim();
function hidden(n: Element) {
  for (let p: Node | undefined = n; p; p = "parentNode" in p ? p.parentNode ?? undefined : undefined)
    if (element(p) && (["script", "style", "template", "noscript"].includes(p.tagName) ||
        p.attrs.some(a => ["hidden", "inert"].includes(a.name)) || attribute(p, "aria-hidden") === "true" ||
        /display\s*:\s*none|visibility\s*:\s*hidden/iu.test(attribute(p, "style") ?? ""))) return true;
  return false;
}
function text(n: Node): string {
  if (element(n) && hidden(n)) return "";
  if (n.nodeName === "#text") return (n as DefaultTreeAdapterMap["textNode"]).value;
  return "childNodes" in n ? n.childNodes.map(text).join(" ") : "";
}
function nodes(root: Node) {
  const result: Element[] = [];
  function visit(n: Node) {
    if (element(n)) { result.push(n); if (result.length > 20000) throw Error("CHELSEA_PUBLIC_DOCUMENT_LIMIT"); }
    if ("childNodes" in n) n.childNodes.forEach(visit);
  }
  visit(root); return result;
}
const only = (values: Element[]) => { if (values.length !== 1) throw Error("CHELSEA_PUBLIC_FORM_CHANGED"); return values[0]; };
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
type Option = { value: string; label: string; selected: boolean };
/** Transient per-response state. It is never recipe metadata or model input. */
export type ChelseaPublicForm = {
  hiddenFields: Record<string, string>; choices: Record<string, Option[]>; calendarYear: number; calendarMonth: number;
  availableDays: number[]; selectedDateLabel: string; sheet: Element | null;
};
export function readChelseaPublicForm(html: string, sourceUrl: string): ChelseaPublicForm {
  if (!parseChelseaPublicSource(sourceUrl) || Buffer.byteLength(html) > 2000000 ||
      !/<html(?:\s|>)/iu.test(html) || !/<body(?:\s|>)/iu.test(html) || !/<\/body\s*>/iu.test(html) || !/<\/html\s*>/iu.test(html))
    throw Error("CHELSEA_PUBLIC_DOCUMENT_INCOMPLETE");
  const all = nodes(parse(html)), form = only(all.filter(n => n.tagName === "form"));
  if (attribute(form, "method")?.toLowerCase() !== "post" || new URL(attribute(form, "action") ?? "", sourceUrl).href !== sourceUrl)
    throw Error("CHELSEA_PUBLIC_FORM_CHANGED");
  const fields = nodes(form), hiddenFields: Record<string, string> = {}, choices: Record<string, Option[]> = {};
  for (const [id, label] of [["lblCourseSelection", "Course"], ["lblQuantity", "# of Golfers"], ["lblHoleSelection", "# of Holes"]])
    if (clean(text(only(fields.filter(n => attribute(n, "id") === id && !hidden(n))))) !== label) throw Error("CHELSEA_PUBLIC_FORM_CHANGED");
  for (const name of ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__EVENTVALIDATION"]) {
    const input = only(fields.filter(n => n.tagName === "input" && attribute(n, "type") === "hidden" && attribute(n, "name") === name));
    const value = attribute(input, "value");
    if (!value || value.length > 200000) throw Error("CHELSEA_PUBLIC_FORM_CHANGED");
    hiddenFields[name] = value;
  }
  for (const name of ["ddlCourse1", "ddlTime", "ddlQuantity", "ddlHoleSelection", "ddlMonth", "ddlYear"]) {
    const select = only(fields.filter(n => n.tagName === "select" && !hidden(n) && attribute(n, "name") === name));
    if (attribute(select, "disabled") !== undefined) throw Error("CHELSEA_PUBLIC_FORM_CHANGED");
    const options = nodes(select).filter(n => n.tagName === "option");
    if (!options.length || options.length > 100 || options.some(n => attribute(n, "disabled") !== undefined)) throw Error("CHELSEA_PUBLIC_FORM_CHANGED");
    choices[name] = options.map(n => ({ value: attribute(n, "value") ?? "", label: clean(text(n)), selected: attribute(n, "selected") !== undefined }));
    if (new Set(choices[name].map(o => o.value)).size !== options.length || choices[name].filter(o => o.selected).length !== 1)
      throw Error("CHELSEA_PUBLIC_FORM_CHANGED");
  }
  if (choices.ddlQuantity.some(o => o.value === "0" ? o.label !== "Select One" :
      !/^[1-4]$/u.test(o.value) || o.label !== `${o.value} ${o.value === "1" ? "Golfer" : "Golfers"}`)) throw Error("CHELSEA_PUBLIC_FORM_CHANGED");
  const calendar = only(fields.filter(n => attribute(n, "id") === "lblCalendar" && !hidden(n)));
  const header = nodes(calendar).find(n => n.tagName === "td"), stamp = header && /^([A-Za-z]+) - (20\d{2})$/u.exec(clean(text(header)));
  const month = stamp ? months.indexOf(stamp[1]) + 1 : 0;
  if (!stamp || !month) throw Error("CHELSEA_PUBLIC_CALENDAR_CHANGED");
  const availableDays = nodes(calendar).filter(n => n.tagName === "a" && !hidden(n)).map(n => {
    const match = /^javascript:__doPostBack\('Day([1-9]|[12]\d|3[01])',''\)$/u.exec(attribute(n, "href") ?? "");
    if (!match || clean(text(n)) !== match[1]) throw Error("CHELSEA_PUBLIC_CALENDAR_CHANGED");
    return Number(match[1]);
  });
  if (new Set(availableDays).size !== availableDays.length) throw Error("CHELSEA_PUBLIC_CALENDAR_CHANGED");
  const labels = fields.filter(n => attribute(n, "id") === "lblSelection" && !hidden(n));
  const sheets = fields.filter(n => attribute(n, "id") === "lblTimes" && !hidden(n));
  if (labels.length > 1 || sheets.length > 1) throw Error("CHELSEA_PUBLIC_FORM_CHANGED");
  return { hiddenFields, choices, calendarYear: Number(stamp[2]), calendarMonth: month, availableDays,
    selectedDateLabel: labels[0] ? clean(text(labels[0])) : "", sheet: sheets[0] ?? null };
}
export function chelseaPublicMetadata(form: ChelseaPublicForm, venueName: string, matches: (expected: string, actual: unknown) => boolean): ChelseaPublicMetadata {
  const courses = form.choices.ddlCourse1.filter(o => /^[1-9]\d{0,9}$/u.test(o.value) && matches(venueName, o.label));
  if (courses.length !== 1) throw Error("ADAPTER_IDENTITY_MISMATCH");
  const rounds = form.choices.ddlHoleSelection.filter(o => o.value !== "NA");
  if (rounds.some(o => !["9", "18"].includes(o.value) || o.label !== `${o.value} Holes`)) throw Error("CHELSEA_PUBLIC_ROUNDS_CHANGED");
  return chelseaPublicMetadataSchema.parse({ family: "CHELSEA", protocol: "PUBLIC_BOOKING_ADMIN_V1", courseCode: Number(courses[0].value),
    courseLabel: courses[0].label, roundHoleCounts: rounds.map(o => Number(o.value)).sort((a, b) => a - b) });
}
export function chelseaPublicAvailability(form: ChelseaPublicForm, metadata: ChelseaPublicMetadata, input: { date: string; players: number }, holes: 9 | 18) {
  const date = new Date(input.date + "T12:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== input.date)
    throw Error("ADAPTER_TARGET_MISMATCH");
  const dateLabel = `${new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(date)} - ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, "0")}, ${date.getUTCFullYear()}`;
  const selected = (name: string) => form.choices[name]?.find(o => o.selected)?.value;
  const times = form.choices.ddlTime.map(o => o.value).sort();
  if (form.selectedDateLabel !== "The date selected is " + dateLabel || selected("ddlCourse1") !== String(metadata.courseCode) ||
      selected("ddlQuantity") !== String(input.players) || selected("ddlHoleSelection") !== String(holes) ||
      selected("ddlMonth") !== input.date.slice(5, 7) || selected("ddlYear") !== input.date.slice(0, 4) ||
      !times.length || times.some(value => !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) || selected("ddlTime") !== times[0] ||
      form.calendarYear !== date.getUTCFullYear() || form.calendarMonth !== date.getUTCMonth() + 1 || !form.sheet)
    throw Error("CHELSEA_PUBLIC_FILTER_UNVERIFIED");
  const tables = nodes(form.sheet).filter(n => n.tagName === "table" && !hidden(n));
  const table = only(tables), firstCell = nodes(table).find(n => n.tagName === "td");
  if (!firstCell || clean(text(firstCell)) !== `Tee Times for ${metadata.courseLabel} on ${dateLabel}`)
    throw Error("CHELSEA_PUBLIC_SHEET_INCOMPLETE");
  const anchors = nodes(table).filter(n => n.tagName === "a" && !hidden(n));
  if (anchors.length > 500) throw Error("ADAPTER_RESPONSE_LIMIT");
  if (nodes(table).filter(n => n.tagName === "a").length !== anchors.length ||
      nodes(form.sheet).some(n => ["script", "iframe", "form"].includes(n.tagName)) ||
      form.sheet.childNodes.some(n => n !== table && clean(text(n)) !== "")) throw Error("CHELSEA_PUBLIC_SHEET_INCOMPLETE");
  const rows = nodes(table).filter(n => n.tagName === "tr" && !hidden(n));
  if (!rows.length || nodes(rows[0]).filter(n => n.tagName === "td").length !== 1 ||
      rows.slice(1).some(row => {
        const cells = nodes(row).filter(n => n.tagName === "td" && !hidden(n));
        return cells.length ? cells.some(cell => nodes(cell).filter(n => n.tagName === "a" && !hidden(n)).length !== 1)
          : clean(text(row)) !== "" || row.attrs.length !== 0 || nodes(row).length !== 1;
      })) throw Error("CHELSEA_PUBLIC_SHEET_INCOMPLETE");
  const seen = new Set<string>();
  return anchors.map(n => {
    const id = attribute(n, "id") ?? "", match = /^(\d{1,2}):([0-5]\d) (am|pm) Hole-(0[1-9]|1[0-8])$/iu.exec(clean(text(n)));
    if (!/^Compare\d{4,40}$/u.test(id) || attribute(n, "href") !== `javascript:__doPostBack('${id}','')` || !match ||
        Number(match[1]) < 1 || Number(match[1]) > 12 || seen.has(id)) throw Error("CHELSEA_PUBLIC_SHEET_INCOMPLETE");
    seen.add(id); const hour = Number(match[1]) % 12 + (match[3].toLowerCase() === "pm" ? 12 : 0);
    return { sourceId: `chelsea-public:${input.date}:${metadata.courseCode}:${holes}:${id}`, time: `${String(hour).padStart(2, "0")}:${match[2]}`,
      // This is the verified server-filtered party-size lower bound. Booked-X
      // text is not parsed into invented exact remaining golfer counts.
      availableSpots: input.players, holes };
  });
}
