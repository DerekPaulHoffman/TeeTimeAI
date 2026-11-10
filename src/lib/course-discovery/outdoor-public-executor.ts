import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { outdoorPublicRoot, farmNeckPublicPage } from "./outdoor-public-roots.mjs";
import { requestFamilyForUrl } from "./request-family";
import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";

const teeQuestOrigin = "https://bookateetime.teequest.com";
const farmNeckApi = new URL("/a_master/net/netcaddy/api", farmNeckPublicPage).href;
const farmNeckSite = 4747;
const roundSchema = z.union([z.literal(9), z.literal(18)]);
export const teeQuestPublicMetadata = z.object({
  family: z.literal("TEEQUEST"), courseKey: z.string().regex(/^[1-9]\d{0,8}-[1-9]\d{0,5}$/u),
  rounds: z.array(roundSchema).min(1).max(2).refine(rounds => rounds.length === 1 || rounds[0] === 9 && rounds[1] === 18),
}).strict();
export const clubEssentialPublicMetadata = z.object({
  family: z.literal("CLUBESSENTIAL"), siteId: z.literal(farmNeckSite), courseId: z.literal(1),
}).strict();
type Metadata = z.infer<typeof teeQuestPublicMetadata> | z.infer<typeof clubEssentialPublicMetadata>;
type Source = { officialUrl?: string; bookingUrl: string; venueName: string; timeZone: string };
type Dependencies = {
  fetch?: typeof fetch;
  deadlineAt?: Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
  venueMatches: (expected: string, observed: unknown) => boolean;
};
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const attr = (element: Element, name: string) => element.attrs.find(item => item.name === name)?.value;
const children = (node: Node): Node[] => "childNodes" in node ? node.childNodes : [];
const plainText = (node: Node): string => "value" in node ? node.value : children(node).map(plainText).join("");
function elements(node: Node, predicate: (node: Element) => boolean): Element[] {
  const found: Element[] = [];
  const pending = [node];
  while (pending.length) {
    const next = pending.pop()!;
    if ("tagName" in next && predicate(next)) found.push(next);
    pending.push(...children(next).slice().reverse());
  }
  return found;
}
function only<T>(values: T[]): T {
  if (values.length !== 1) throw Error("PUBLIC_OUTDOOR_DOCUMENT_CHANGED");
  return values[0];
}

function readSession(deps: Dependencies) {
  const end = Math.min(deps.deadlineAt?.getTime() ?? Infinity, Date.now() + 45_000);
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.max(1, end - Date.now()))]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  let reads = 0;
  let bytes = 0;
  return {
    get observation() { return { publicRequests: reads, publicResponseBytes: bytes }; },
    async read(url: string, contentType: "text/html" | "application/json") {
      if (Date.now() >= end || ++reads > 6) throw Error("PUBLIC_OUTDOOR_READ_LIMIT");
      // The caller constructs exact GET routes from the verified public entry.
      const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({
        parseUrl: candidate => { if (candidate !== url) throw Error("UNSCOPED_ADAPTER_REQUEST"); return new URL(candidate); },
        maxResponseBytes: 600_000, timeoutMs: 12_000, redirectLimit: 0,
      });
      return queue.run(requestFamilyForUrl(url), async () => {
        const response = await transport(url, { method: "GET", headers: { accept: contentType },
          redirect: "manual", credentials: "omit", cache: "no-store", signal });
        try {
          if (response.status === 429) throw Error("PROVIDER_THROTTLED");
          if ([401, 403].includes(response.status)) throw Error("ACCESS_REQUIRED");
          if (response.status !== 200 || response.redirected || response.url && response.url !== url)
            throw Error("ADAPTER_TRANSPORT_FAILED");
          if (response.headers.get("content-type")?.split(";")[0].trim() !== contentType)
            throw Error("ADAPTER_RESPONSE_INVALID");
          const data = await response.arrayBuffer();
          bytes += data.byteLength;
          if (!data.byteLength || data.byteLength > 600_000 || bytes > 2_000_000) throw Error("ADAPTER_RESPONSE_LIMIT");
          return new TextDecoder().decode(data);
        } finally {
          if (response.body && !response.bodyUsed) await response.body.cancel().catch(() => undefined);
        }
      });
    },
    close() { abort.abort(); queue.dispose(); },
  };
}

async function inspect(source: Source, deps: Dependencies, session: ReturnType<typeof readSession>): Promise<Metadata> {
  const root = outdoorPublicRoot(source.officialUrl);
  if (!root || root.bookingUrl !== source.bookingUrl || source.timeZone !== "America/New_York") throw Error("INVALID_ADAPTER_SOURCE");
  const html = await session.read(root.bookingUrl, "text/html");
  const doc = parse(html);
  if (root.family === "CLUBESSENTIAL") {
    const title = plainText(only(elements(doc, node => node.tagName === "title")));
    if (!deps.venueMatches(source.venueName, title.replace(/^Public Tee Times\s*-\s*/u, "")) ||
        !elements(doc, node => attr(node, "id") === "htngGolfActionUpdate").length ||
        !html.includes(`var SiteId = '${farmNeckSite}';`) || !html.includes(`var PathToREST = '${farmNeckApi}';`))
      throw Error("ADAPTER_IDENTITY_MISMATCH");
    // This course ID was observed on the signed-out search on this exact site.
    return { family: "CLUBESSENTIAL", siteId: farmNeckSite, courseId: 1 };
  }

  const frame = only(elements(doc, node => node.tagName === "iframe" &&
    /^https:\/\/bookateetime\.teequest\.com\/course\/[1-9]\d{0,8}$/u.test(attr(node, "src") ?? "")));
  const providerUrl = attr(frame, "src")!;
  const facilityId = new URL(providerUrl).pathname.split("/").at(-1)!;
  const page = parse(await session.read(providerUrl, "text/html"));
  const selected = only(elements(page, node => node.tagName === "input" && attr(node, "name") === "selectedCourse" && attr(node, "checked") !== undefined));
  const courseKey = attr(selected, "value") ?? "";
  const label = only(elements(page, node => node.tagName === "label" && attr(node, "for") === attr(selected, "id")));
  if (!courseKey.startsWith(`${facilityId}-`) || !deps.venueMatches(source.venueName, plainText(label)))
    throw Error("ADAPTER_IDENTITY_MISMATCH");
  const rounds = elements(page, node => node.tagName === "input" && attr(node, "name") === "selectedHoles")
    .map(node => roundSchema.parse(Number(attr(node, "value")))).sort((a, b) => a - b);
  return teeQuestPublicMetadata.parse({ family: "TEEQUEST", courseKey, rounds });
}

export async function inspectOutdoorPublic(source: Source, deps: Dependencies) {
  const session = readSession(deps);
  try {
    const adapter = await inspect(source, deps, session);
    return { adapter, observation: session.observation };
  } finally { session.close(); }
}

function localDate(date: string) {
  const [year, month, day] = date.split("-");
  return `${month}/${day}/${year}`;
}

async function teeQuestSlots(adapter: z.infer<typeof teeQuestPublicMetadata>, input: AccessExecutionInput, session: ReturnType<typeof readSession>) {
  const slots = new Map<string, { startsAt: string; availableSpots: number; holes: 9 | 18 }>();
  for (const holes of adapter.rounds) {
    for (const walking of [true, false]) {
      const search = new URL(`/search/${adapter.courseKey}/${input.date}`, teeQuestOrigin);
      search.searchParams.set("selectedPlayers", String(input.players));
      search.searchParams.set("selectedHoles", String(holes));
      if (walking) search.searchParams.set("walking", "true");
      const page = parse(await session.read(search.href, "text/html"));
      const filter = only(elements(page, node => attr(node, "id") === "search"));
      const day = only(elements(filter, node => attr(node, "id") === "teeDate"));
      const selectedCourse = only(elements(filter, node => attr(node, "name") === "selectedCourse" && attr(node, "checked") !== undefined));
      const selectedRound = only(elements(filter, node => attr(node, "name") === "selectedHoles" && attr(node, "checked") !== undefined));
      if (attr(day, "value") !== localDate(input.date) || attr(filter, "data-initial-players") !== String(input.players) ||
          attr(selectedCourse, "value") !== adapter.courseKey || attr(selectedRound, "value") !== String(holes))
        throw Error("PUBLIC_OUTDOOR_FILTER_UNVERIFIED");
      const sheet = only(elements(page, node => attr(node, "id") === "teeTimes"));
      const rows = elements(sheet, node => (attr(node, "class") ?? "").split(/\s+/u).includes("tee-time"));
      if (!rows.length && !/\bno tee times (?:found|available)\b/iu.test(plainText(sheet))) throw Error("PUBLIC_OUTDOOR_RESULT_INCOMPLETE");
      if (rows.length > 250) throw Error("ADAPTER_RESPONSE_LIMIT");
      for (const row of rows) {
        const time = attr(row, "data-date-time") ?? "";
        const spots = attr(row, "data-available") ?? "";
        const stamp = input.date.replaceAll("-", "");
        if (!/^\d{8}(?:[01]\d|2[0-3])[0-5]\d$/u.test(time) || !time.startsWith(stamp) || !/^[0-4]$/u.test(spots))
          throw Error("PUBLIC_OUTDOOR_RESULT_INVALID");
        const id = `${time}-${holes}`, availableSpots = Number(spots);
        if (availableSpots >= input.players && availableSpots > (slots.get(id)?.availableSpots ?? 0))
          slots.set(id, { startsAt: `${input.date}T${time.slice(8, 10)}:${time.slice(10)}:00`, availableSpots, holes });
      }
    }
  }
  return [...slots].map(([sourceId, slot]) => ({ sourceId, ...slot }));
}

const clubEssentialResult = z.object({
  ServerTimeUTC: z.string().datetime({ offset: true }),
  Results: z.array(z.object({
    ID: z.literal(0), SiteID: z.literal(farmNeckSite), CourseId: z.literal(1), status: z.literal(0),
    startTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00$/u),
    holes: roundSchema,
    Golfers: z.array(z.object({ MemberId: z.union([z.literal(0), z.null()]), FirstName: z.union([z.literal(""), z.null()]),
      LastName: z.union([z.literal(""), z.null()]) })).min(1).max(4),
  })).max(250),
});

async function clubEssentialSlots(input: AccessExecutionInput, session: ReturnType<typeof readSession>, now: Date) {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: input.timeZone }).format(now);
  const daysAhead = (Date.parse(input.date) - Date.parse(today)) / 86_400_000;
  if (!Number.isInteger(daysAhead) || daysAhead < 0 || daysAhead > 3) throw Error("PUBLIC_OUTDOOR_DATE_NOT_OPEN");
  const date = localDate(input.date);
  const url = new URL(farmNeckApi + "/teetimes/Available");
  url.search = new URLSearchParams({ courseId: "GOLFCOURSE-1", date, enddate: date, st: "06:00AM", ed: "07:00PM",
    min: String(input.players), max: String(input.players), rCode: "", pCode: "", gCode: "", cCode: "", market: "", submarket: "" }).toString();
  const { Results: rows } = clubEssentialResult.parse(JSON.parse(await session.read(url.href, "application/json")));
  const found = new Set<string>();
  return rows.map(row => {
    const sourceId = `${row.startTime}-${row.holes}`;
    if (!row.startTime.startsWith(input.date + "T") || row.Golfers.length !== input.players || found.has(sourceId))
      throw Error("PUBLIC_OUTDOOR_RESULT_INVALID");
    found.add(sourceId);
    return { sourceId, startsAt: row.startTime, availableSpots: input.players, holes: row.holes };
  });
}

export async function executeOutdoorPublic(source: Source, saved: Metadata, input: AccessExecutionInput,
  deps: Dependencies & { now?: () => Date; toInstant: (value: unknown, input: AccessExecutionInput) => Date }): Promise<AccessExecutionResult["slots"]> {
  if (input.timeZone !== source.timeZone || input.durationMinutes !== undefined || input.players > 4) throw Error("ADAPTER_TARGET_MISMATCH");
  const session = readSession(deps);
  try {
    const fresh = await inspect(source, deps, session);
    if (JSON.stringify(fresh) !== JSON.stringify(saved)) throw Error("ADAPTER_CONFIGURATION_CHANGED");
    const rows = fresh.family === "TEEQUEST" ? await teeQuestSlots(fresh, input, session) :
      await clubEssentialSlots(input, session, deps.now?.() ?? new Date());
    return rows.map(row => ({ ...row, startsAt: deps.toInstant(row.startsAt, input).toISOString(), bookingUrl: source.bookingUrl }))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.holes - b.holes);
  } finally { session.close(); }
}
