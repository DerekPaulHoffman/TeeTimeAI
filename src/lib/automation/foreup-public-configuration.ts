import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";

const MAX_DOCUMENT_BYTES = 512_000;
const MAX_SCHEDULE_JSON_CHARS = 256_000;
const MAX_SCHEDULES = 30;
const FOREUP_BOOKING_PATH = /^\/index\.php\/booking\/([1-9]\d{0,9})(?:\/[1-9]\d{0,9})?\/?$/u;

export type ForeupPublicConfiguration = {
  sourceBookingUrl: string;
  bookingBaseUrl: string;
  scheduleId: number;
  bookingClassId: number;
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
  const facilityId = Number(path[1]);
  const targetName = normalizeName(input.courseName);
  const schedules = extractSchedulesJson(input.html);
  if (!targetName || !Array.isArray(schedules) || schedules.length < 1 ||
    schedules.length > MAX_SCHEDULES) return null;
  const matching = schedules.filter((schedule) => {
    if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) return false;
    const entry = schedule as Record<string, unknown>;
    const title = normalizeName(entry.title);
    return positiveProviderId(entry.course_id) === facilityId &&
      title.length >= 5 &&
      (targetName === title || targetName.endsWith(` ${title}`));
  });
  if (matching.length !== 1) return null;
  const selected = matching[0] as Record<string, unknown>;
  const scheduleId = positiveProviderId(selected.teesheet_id);
  const classes = selected.booking_classes;
  if (!scheduleId || !Array.isArray(classes) || classes.length > 20) return null;
  const publicClasses = classes.filter((bookingClass) => {
    if (!bookingClass || typeof bookingClass !== "object" || Array.isArray(bookingClass)) return false;
    const entry = bookingClass as Record<string, unknown>;
    return positiveProviderId(entry.teesheet_id) === scheduleId &&
      String(entry.active) === "1" && String(entry.hidden) === "0" &&
      positiveProviderId(entry.booking_class_id) !== null;
  });
  if (publicClasses.length !== 1) return null;
  const bookingClassId = positiveProviderId((publicClasses[0] as Record<string, unknown>).booking_class_id)!;
  return {
    sourceBookingUrl: `https://foreupsoftware.com/index.php/booking/${facilityId}#/teetimes`,
    bookingBaseUrl: `https://foreupsoftware.com/index.php/booking/${facilityId}/${scheduleId}#/teetimes`,
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

export async function readForeupPublicConfiguration(input: {
  bookingUrl: string;
  courseName: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  rethrowError?: (error: unknown) => boolean;
}): Promise<ForeupPublicConfiguration | null> {
  let source: URL;
  try { source = new URL(input.bookingUrl); }
  catch { return null; }
  if (source.protocol !== "https:" || source.hostname !== "foreupsoftware.com" ||
    source.username || source.password || source.port || source.search ||
    !FOREUP_BOOKING_PATH.test(source.pathname) ||
    !["", "#/teetimes", "#teetimes", "#/login"].includes(source.hash)) return null;
  source.hash = "";
  try {
    const response = await fetchWithProviderTimeout(source, {
      headers: { accept: "text/html,application/xhtml+xml" }, redirect: "manual", signal: input.signal,
    }, input.fetchImpl);
    if (response.status !== 200 ||
      !response.headers.get("content-type")?.toLocaleLowerCase("en-US").includes("text/html")) return null;
    const html = await readBoundedText(response);
    if (!html) return null;
    const config = parseForeupPublicConfiguration({ ...input, html });
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
    return Array.isArray(data) || data === false ? config : null;
  } catch (error) {
    if (input.rethrowError?.(error)) throw error;
    return null;
  }
}
