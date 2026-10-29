import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";
import { createHash } from "node:crypto";
import { isPhysicalCourseName, type DetectedFacility } from "@/lib/courses/shared-facility-detection";

const MAX_DOCUMENT_BYTES = 512_000;
const MAX_SCHEDULE_JSON_CHARS = 256_000;
const MAX_SCHEDULES = 30;
export const FOREUP_STANDARD_PUBLIC_SCOPE = "STANDARD_PUBLIC_CLASS_V1" as const;
export function isStandardForeupPublicClassName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(value) &&
    /^(?:public|(?:(?:spring|summer|fall|winter) )?public play|public tee times|online tee times)$/iu.test(value.trim());
}
const FOREUP_BOOKING_PATH = /^\/index\.php\/booking\/(?:([1-9]\d{0,9})(?:\/[1-9]\d{0,9})?|index\/([1-9]\d{0,9}))\/?$/u;

export type ForeupPublicConfiguration = {
  sourceBookingUrl: string;
  bookingBaseUrl: string;
  scheduleId: number;
  bookingClassId: number;
  detectedFacility?: DetectedFacility;
};

function positiveProviderId(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value);
  if (!/^[1-9]\d{0,9}$/u.test(raw)) return null;
  const number = Number(raw);
  return number <= 2_147_483_647 ? number : null;
}

function normalizeName(value: unknown): string {
  return typeof value === "string"
    ? value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, " ")
      .replace(/\b(?:golf|course|club)\b/gu, " ").replace(/\s+/gu, " ").trim()
    : "";
}

function extractSchedulesJson(html: string): unknown {
  const assignments = [...html.matchAll(/\bSCHEDULES\s*=\s*\[/gu)];
  if (assignments.length !== 1) return null;
  const start = assignments[0].index! + assignments[0][0].length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length && index - start < MAX_SCHEDULE_JSON_CHARS; index += 1) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, index + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

/** Managed single-sheet recipes cannot prove absence across other public
 * sheets. A different provider ID alone does not prove a different venue. */
export function hasCompleteForeupPublicScheduleScope(input: { html: string; facilityId: number; scheduleId: number;
  isProvenForeignSchedule?: (schedule: Record<string, unknown>) => boolean;
  inventoryScope?: typeof FOREUP_STANDARD_PUBLIC_SCOPE }): boolean {
  if (input.html.length > MAX_DOCUMENT_BYTES) return false;
  const schedules = extractSchedulesJson(input.html);
  if (!Array.isArray(schedules) || !schedules.length || schedules.length > MAX_SCHEDULES) return false;
  const publicSheets = new Set<string>();
  const foreignSheets = new Set<string>();
  for (const raw of schedules) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const row = raw as Record<string, unknown>, facilityId = positiveProviderId(row.course_id), scheduleId = positiveProviderId(row.teesheet_id);
    if (!facilityId || !scheduleId) return false;
    const provenForeign = input.isProvenForeignSchedule?.(row) === true;
    if (provenForeign && input.inventoryScope !== FOREUP_STANDARD_PUBLIC_SCOPE) continue;
    if (!Array.isArray(row.booking_classes) || row.booking_classes.length > 20) return false;
    const visible: Record<string, unknown>[] = [];
    for (const rawClass of row.booking_classes) {
      if (!rawClass || typeof rawClass !== "object" || Array.isArray(rawClass)) return false;
      const entry = rawClass as Record<string, unknown>;
      if (positiveProviderId(entry.teesheet_id) !== scheduleId || !["0", "1"].includes(String(entry.active)) || !["0", "1"].includes(String(entry.hidden))) return false;
      if (String(entry.active) === "0" || String(entry.hidden) === "1") continue;
      if (!positiveProviderId(entry.booking_class_id)) return false;
      visible.push(entry);
    }
    if (provenForeign) {
      // Physical ownership was independently proved by the caller. Its audience
      // names cannot expand this venue's inventory, but every catalog row must
      // still have closed IDs, flags and bounded class-name scalars.
      const key = `${facilityId}:${scheduleId}`, classIds = new Set<number>();
      if (foreignSheets.has(key)) return false;
      foreignSheets.add(key);
      for (const entry of row.booking_classes as Record<string, unknown>[]) {
        const classId = positiveProviderId(entry.booking_class_id);
        if (!classId || classIds.has(classId) || typeof entry.name !== "string" || !entry.name.trim() ||
            entry.name.length > 300 || /[\u0000-\u001f\u007f]/u.test(entry.name)) return false;
        classIds.add(classId);
      }
      continue;
    }
    let isPublic = false;
    let selectedExplicitPublicCount = 0;
    const selectedClassIds = new Set<number>();
    const selectedStandardPublic = input.inventoryScope === FOREUP_STANDARD_PUBLIC_SCOPE &&
      facilityId === input.facilityId && scheduleId === input.scheduleId;
    for (const entry of visible) {
      if (selectedStandardPublic) {
        // The declared inventory is the sole explicit Public class. Other
        // visible audiences on this exact sheet are outside that inventory.
        const classId = positiveProviderId(entry.booking_class_id);
        if (!classId || selectedClassIds.has(classId)) return false;
        selectedClassIds.add(classId);
        if (typeof entry.name !== "string" || entry.name.length > 300 || /[\u0000-\u001f\u007f]/u.test(entry.name)) return false;
        if (isStandardForeupPublicClassName(entry.name)) selectedExplicitPublicCount += 1;
        continue;
      }
      if (entry.name === undefined && visible.length === 1) { isPublic = true; continue; }
      if (typeof entry.name !== "string" || entry.name.length > 300) return false;
      const name = entry.name.trim();
      if (isStandardForeupPublicClassName(name)) isPublic = true;
      // Only unequivocal membership labels exclude a visible class. Unknown
      // labels may describe another public audience and cannot prove coverage.
      else if (!/^(?:(?:full(?: week)?|twilight|junior|senior|annual|club|premium) )?(?:member|members|membership)(?: (?:only|tee times|play))?$/iu.test(name)) return false;
    }
    if (selectedStandardPublic) {
      if (selectedExplicitPublicCount !== 1) return false;
      isPublic = true;
    }
    if (isPublic) {
      const key = `${facilityId}:${scheduleId}`;
      if (publicSheets.has(key)) return false;
      publicSheets.add(key);
    }
  }
  return publicSheets.size === 1 && publicSheets.has(`${input.facilityId}:${input.scheduleId}`);
}

/** Exact bounded catalog evidence for a newly declared Standard Public recipe.
 * Replay re-reads the public document and compares the same digest. */
export function foreupPublicScheduleCatalogSha256(html: string): string | null {
  if (html.length > MAX_DOCUMENT_BYTES) return null;
  const schedules = extractSchedulesJson(html);
  if (!Array.isArray(schedules) || !schedules.length || schedules.length > MAX_SCHEDULES) return null;
  return createHash("sha256").update(JSON.stringify(schedules)).digest("hex");
}

/** Distinguishes a named Public class from the older sole unlabelled class.
 * A failed scoped proof may use the legacy strict path only for the latter. */
export function isExplicitForeupPublicClass(input: { html: string; facilityId: number; scheduleId: number; bookingClassId: number }): boolean {
  if (input.html.length > MAX_DOCUMENT_BYTES) return false;
  const schedules = extractSchedulesJson(input.html);
  if (!Array.isArray(schedules) || schedules.length < 1 || schedules.length > MAX_SCHEDULES) return false;
  const selected = schedules.filter(row => row && typeof row === "object" && !Array.isArray(row) &&
    positiveProviderId((row as Record<string, unknown>).course_id) === input.facilityId &&
    positiveProviderId((row as Record<string, unknown>).teesheet_id) === input.scheduleId);
  if (selected.length !== 1) return false;
  const classes = (selected[0] as Record<string, unknown>).booking_classes;
  return Array.isArray(classes) && classes.some(raw => raw && typeof raw === "object" && !Array.isArray(raw) &&
    positiveProviderId((raw as Record<string, unknown>).booking_class_id) === input.bookingClassId &&
    positiveProviderId((raw as Record<string, unknown>).teesheet_id) === input.scheduleId &&
    String((raw as Record<string, unknown>).active) === "1" && String((raw as Record<string, unknown>).hidden) === "0" &&
    typeof (raw as Record<string, unknown>).name === "string" &&
    isStandardForeupPublicClassName((raw as Record<string, unknown>).name));
}

export function parseForeupPublicConfiguration(input: {
  bookingUrl: string;
  courseName: string;
  html: string;
}): ForeupPublicConfiguration | null {
  let url: URL;
  try { url = new URL(input.bookingUrl); }
  catch { return null; }
  const path = FOREUP_BOOKING_PATH.exec(url.pathname);
  if (url.protocol !== "https:" || url.hostname !== "foreupsoftware.com" ||
    url.username || url.password || url.port || url.search || !path ||
    !["", "#/teetimes", "#teetimes", "#/login"].includes(url.hash) ||
    input.html.length > MAX_DOCUMENT_BYTES) return null;
  const facilityId = Number(path[1] ?? path[2]);
  // A comma-separated hospitality descriptor is not a tee-sheet identity.
  // This one bounded suffix affects configuration comparison only; facility,
  // unique schedule and explicit public-class gates below remain unchanged.
  const comparisonName = typeof input.courseName === "string"
    ? input.courseName.replace(/,[ \t]*restaurant[ \t]+and[ \t]+banquet[ \t]+facility[ \t]*$/iu, "") : input.courseName;
  const targetName = normalizeName(comparisonName);
  const schedules = extractSchedulesJson(input.html);
  if (!targetName || !Array.isArray(schedules) || schedules.length < 1 ||
    schedules.length > MAX_SCHEDULES) return null;
  const matching = schedules.filter((schedule) => {
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return false;
    const entry = schedule as Record<string, unknown>;
    // A provider's structural schedule suffix is not part of venue identity.
    const title = normalizeName(entry.title).replace(/\b(?:9|18) holes?$/u, "").replace(/\btee sheet$/u, "").trim();
    // course_name and title can carry different legitimate facility/business
    // labels. Either identity match belongs to this same route-owned row.
    const hasOwnerName = Object.hasOwn(entry, "course_name");
    const validOwnerName = typeof entry.course_name === "string" && entry.course_name.trim().length > 0 &&
      entry.course_name.length <= 300 && !/[\u0000-\u001f\u007f]/u.test(entry.course_name);
    const ownerName = validOwnerName ? normalizeName(entry.course_name) : "";
    return positiveProviderId(entry.course_id) === facilityId &&
      title.length >= 5 && (!hasOwnerName || validOwnerName) &&
      (hasOwnerName && targetName === ownerName || targetName === title || targetName.endsWith(` ${title}`));
  });
  // Shared facilities repeat course_name on every sheet. A unique physical
  // course title is stronger evidence than that facility-wide owner label.
  // Never use a saved schedule id to break an otherwise ambiguous identity.
  const exactTitles = matching.filter(raw => {
    const title = normalizeName((raw as Record<string, unknown>).title)
      .replace(/\b(?:9|18) holes?$/u, "").replace(/\btee sheet$/u, "").trim();
    return title === targetName;
  });
  const candidates = exactTitles.length ? exactTitles : matching;
  if (candidates.length !== 1) return null;
  const selected = candidates[0] as Record<string, unknown>;
  const scheduleId = positiveProviderId(selected.teesheet_id);
  const classes = selected.booking_classes;
  if (!scheduleId || !Array.isArray(classes) || classes.length > 20) return null;
  const visibleClasses = classes.filter((bookingClass) => {
    if (!bookingClass || typeof bookingClass !== "object" || Array.isArray(bookingClass)) return false;
    const entry = bookingClass as Record<string, unknown>;
    return positiveProviderId(entry.teesheet_id) === scheduleId &&
      String(entry.active) === "1" && String(entry.hidden) === "0" &&
      positiveProviderId(entry.booking_class_id) !== null;
  });
  const labelledPublic = visibleClasses.filter(bookingClass => {
    const name = (bookingClass as Record<string, unknown>).name;
    return isStandardForeupPublicClassName(name);
  });
  // Public and membership classes may share one public page. Select only its
  // sole explicit public class (including observed public tee-time labels);
  // retain the legacy single unlabelled configuration.
  const publicClasses = labelledPublic.length ? labelledPublic : visibleClasses.length === 1 &&
    (visibleClasses[0] as Record<string, unknown>).name === undefined ? visibleClasses : [];
  if (publicClasses.length !== 1) return null;
  const bookingClassId = positiveProviderId((publicClasses[0] as Record<string, unknown>).booking_class_id)!;
  return {
    // The indexed public landing is itself the observed source. Its schedule
    // comes from the fresh SCHEDULES document, never a rewritten URL.
    sourceBookingUrl: path[2] ? input.bookingUrl : `https://foreupsoftware.com/index.php/booking/${facilityId}#/teetimes`,
    bookingBaseUrl: path[2] ? input.bookingUrl : `https://foreupsoftware.com/index.php/booking/${facilityId}/${scheduleId}#/teetimes`,
    scheduleId,
    bookingClassId,
  };
}

async function readBoundedText(response: Response): Promise<string | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DOCUMENT_BYTES) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

async function readForeupPublicDocument(input: {
  bookingUrl: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{ html: string; facilityId: number } | null> {
  let source: URL;
  try { source = new URL(input.bookingUrl); }
  catch { return null; }
  const path = FOREUP_BOOKING_PATH.exec(source.pathname);
  if (source.protocol !== "https:" || source.hostname !== "foreupsoftware.com" ||
    source.username || source.password || source.port || source.search || !path ||
    !["", "#/teetimes", "#teetimes", "#/login"].includes(source.hash)) return null;
  source.hash = "";
  const response = await fetchWithProviderTimeout(source, {
    headers: { accept: "text/html,application/xhtml+xml" }, redirect: "manual", signal: input.signal,
  }, input.fetchImpl);
  if (response.status !== 200 ||
    !response.headers.get("content-type")?.toLocaleLowerCase("en-US").includes("text/html")) return null;
  const html = await readBoundedText(response);
  return html ? { html, facilityId: Number(path[1] ?? path[2]) } : null;
}

/** One fresh bounded public catalog read for an ordinary Course check. The
 * selected class is ephemeral; this function never updates stored metadata. */
export async function readForeupStandardPublicSchedule(input: {
  bookingUrl: string;
  courseName: string;
  scheduleId: number;
  bookingClassId?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<ForeupPublicConfiguration | null> {
  try {
    // A saved sheet-specific booking link must name the same sheet as the
    // Course metadata. Facility-only and indexed landing links have no sheet
    // segment and remain valid sources for the fresh catalog comparison.
    const path = new URL(input.bookingUrl).pathname;
    const linkedSheet = /^\/index\.php\/booking\/[1-9]\d{0,9}\/([1-9]\d{0,9})\/?$/u.exec(path);
    if (linkedSheet && Number(linkedSheet[1]) !== input.scheduleId) return null;
    const document = await readForeupPublicDocument(input);
    if (!document) return null;
    const config = parseForeupPublicConfiguration({ ...input, html: document.html });
    if (!config || config.scheduleId !== input.scheduleId ||
      (input.bookingClassId !== undefined && config.bookingClassId !== input.bookingClassId) ||
      !isExplicitForeupPublicClass({ html: document.html, facilityId: document.facilityId,
        scheduleId: config.scheduleId, bookingClassId: config.bookingClassId })) return null;
    // This ordinary check covers only the named Course's exact sheet/class.
    // Managed recipes still use hasCompleteForeupPublicScheduleScope: checking
    // one course here never proves absence across a whole shared facility.
    return withDetectedForeupFacility(config, input.courseName, document.html, document.facilityId);
  } catch {
    return null;
  }
}

export async function readForeupPublicConfiguration(input: {
  bookingUrl: string;
  courseName: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  rethrowError?: (error: unknown) => boolean;
  /** Trusted fixed inspector hook, never a model/recipe option. */
  parseDocument?: (html: string) => Promise<ForeupPublicConfiguration | null>;
}): Promise<ForeupPublicConfiguration | null> {
  try {
    const document = await readForeupPublicDocument(input);
    if (!document) return null;
    const config = input.parseDocument ? await input.parseDocument(document.html) :
      parseForeupPublicConfiguration({ ...input, html: document.html });
    if (!config) return null;
    const today = new Date().toISOString().slice(0, 10);
    const [year, month, day] = today.split("-");
    const api = new URL("https://foreupsoftware.com/index.php/api/booking/times");
    for (const [key, value] of Object.entries({
      time: "all", date: `${month}-${day}-${year}`, holes: "all", players: "1",
      schedule_id: String(config.scheduleId), booking_class: String(config.bookingClassId),
    })) api.searchParams.set(key, value);
    const check = await fetchWithProviderTimeout(api, {
      headers: { accept: "application/json" }, redirect: "manual", signal: input.signal,
    }, input.fetchImpl);
    if (check.status !== 200 ||
      !check.headers.get("content-type")?.toLocaleLowerCase("en-US").includes("application/json")) return null;
    const payload = await readBoundedText(check);
    if (!payload) return null;
    const data = JSON.parse(payload) as unknown;
    return Array.isArray(data) || data === false ? withDetectedForeupFacility(config, input.courseName, document.html, document.facilityId) : null;
  } catch (error) {
    if (input.rethrowError?.(error)) throw error;
    return null;
  }
}

function withDetectedForeupFacility(config: ForeupPublicConfiguration, courseName: string, html: string, facilityId: number): ForeupPublicConfiguration {
  const schedules = extractSchedulesJson(html);
  if (!Array.isArray(schedules) || schedules.length > MAX_SCHEDULES) return config;
  const primary = schedules.filter(row => row && positiveProviderId(row.course_id) === facilityId && positiveProviderId(row.teesheet_id) === config.scheduleId);
  if (primary.length !== 1 || typeof primary[0].course_name !== "string") return config;
  const courses: DetectedFacility["courses"] = [];
  const seen = new Set<number>();
  for (const raw of schedules) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return config;
    const row = raw as Record<string, unknown>;
    if (positiveProviderId(row.course_id) !== facilityId || normalizeName(row.course_name) !== normalizeName(primary[0].course_name)) continue;
    const id = positiveProviderId(row.teesheet_id);
    if (!id || seen.has(id)) return config;
    seen.add(id);
    if (typeof row.title !== "string") continue;
    const name = id === config.scheduleId ? courseName : row.title.replace(/\s*\((?:9|18)\s*holes?\)\s*$/iu, "").replace(/\s+tee\s*sheet\s*$/iu, "").trim();
    // The named public physical sheet is evidence; rates, audiences, and round
    // products are not. Never infer a physical hole count from the catalog.
    if (!isPhysicalCourseName(name) || id !== config.scheduleId && !/\b(?:golf|course|links)\b/iu.test(name)) continue;
    const selected = parseForeupPublicConfiguration({ bookingUrl: config.sourceBookingUrl, courseName: name, html });
    if (!selected || selected.scheduleId !== id || !isExplicitForeupPublicClass({ html, facilityId, scheduleId: id, bookingClassId: selected.bookingClassId })) continue;
    courses.push({ key: String(id), name, url: selected.bookingBaseUrl, publicAccess: "PUBLIC", foreup: {
      scheduleId: id, bookingClassId: selected.bookingClassId, bookingBaseUrl: selected.bookingBaseUrl,
    } });
  }
  if (!courses.some(row => row.key === String(config.scheduleId)) || courses.length > 10 ||
      new Set(courses.map(row => normalizeName(row.name))).size !== courses.length) return config;
  return { ...config, detectedFacility: { method: "FOREUP_PUBLIC_CATALOG", sourceUrl: config.sourceBookingUrl,
    observedAt: new Date().toISOString(), primaryKey: String(config.scheduleId), courses } };
}
