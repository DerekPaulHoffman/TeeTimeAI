import { parse as parseScript } from "acorn";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";

import { fetchWithProviderTimeout } from "@/lib/adapters/fetch-with-timeout";
import { simulatorPublicConfigurationSchema, uschedulePublicTenant, type USchedulePublicConfiguration } from "./public-configuration";
import { SimulatorAvailabilityError, type SimulatorAvailabilityInput, type SimulatorAvailabilityResult,
  type SimulatorAvailabilitySlot } from "./types";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const MAX_HTML_BYTES = 600_000, MAX_JSON_BYTES = 8_000, MAX_PAGES = 8;
const PUBLIC_ID = /^[1-9]\d{0,9}$/u;
const metadataSchema = z.object({ tenant: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
  serviceId: z.string().regex(PUBLIC_ID) }).strict();

const sourceError = (message: string) => new SimulatorAvailabilityError("INVALID_SOURCE", message);
const schemaError = (message: string) => new SimulatorAvailabilityError("SCHEMA_CHANGED", message);
function elements(node: Node): Element[] {
  return "childNodes" in node ? node.childNodes.flatMap(child => "tagName" in child ? [child, ...elements(child)] : elements(child)) : [];
}
function children(node: Node): Element[] {
  return "childNodes" in node ? node.childNodes.filter((child): child is Element => "tagName" in child) : [];
}
function attr(node: Element, key: string) { return node.attrs.find(item => item.name === key)?.value; }
function visibleText(node: Node): string {
  if ("value" in node) return node.value;
  if ("tagName" in node && ["script", "style", "textarea", "input"].includes(node.tagName)) return "";
  return "childNodes" in node ? node.childNodes.map(visibleText).join(" ") : "";
}
function accessChanged(html: string) {
  const document = parse(html);
  const visible = visibleText(document).replace(/\s+/gu, " ");
  return /verify (?:that )?you are human|checking your browser|complete the captcha|(?:sign|log) in (?:is required|to continue)|authentication required|you are (?:now )?in (?:a|the) queue/iu.test(visible) ||
    elements(document).some(node => node.attrs.some(item => ["id", "class"].includes(item.name) &&
      /(?:cf-chl|challenge-form|g-recaptcha|h-captcha|cf-turnstile)/iu.test(item.value)) ||
      node.tagName === "input" && attr(node, "type") === "password" ||
      node.tagName === "iframe" && /recaptcha|hcaptcha|challenges\.cloudflare/iu.test(attr(node, "src") ?? ""));
}
function selectedRental(html: string) {
  if (accessChanged(html)) throw sourceError("The public simulator scheduler now requires interactive access");
  const all = elements(parse(html));
  const options = (id: string) => {
    const selects = all.filter(node => node.tagName === "select" && attr(node, "id") === id);
    if (selects.length !== 1) throw sourceError("The public simulator rental selectors are missing or ambiguous");
    return elements(selects[0]).filter(node => node.tagName === "option");
  };
  const services = options("select_service"), lengths = options("select_length");
  const selected = (node: Element) => node.attrs.some(item => item.name === "selected");
  if (services.length !== 1 || !selected(services[0]) || visibleText(services[0]).replace(/\s+/gu, " ").trim() !== "Simulator Rental" ||
      !PUBLIC_ID.test(attr(services[0], "value") ?? "") || lengths.length < 1 || lengths.length > 7 ||
      lengths.filter(selected).length !== 1 || attr(lengths.find(selected)!, "value") !== "60" ||
      lengths.some(node => !/^(?:60|90|120|150|180|210|240)$/u.test(attr(node, "value") ?? "")) ||
      new Set(lengths.map(node => attr(node, "value"))).size !== lengths.length) {
    throw sourceError("The reviewed default one-hour Simulator Rental is no longer unambiguous");
  }
  return { serviceId: attr(services[0], "value")!, durationMinutes: 60 as const };
}
function pooledRows(html: string) {
  const all = elements(parse(html));
  const containers = all.filter(node => (attr(node, "class") ?? "").split(/\s+/u).includes("next_avail_results"));
  if (!containers.length || containers.length > 10) throw schemaError("The public availability list is missing or ambiguous");
  // The public page renders one result container per start, with one direct
  // row inside each. An orphan or nested row would leave the page incomplete.
  const rows = containers.map(container => {
    const direct = children(container);
    if (direct.length !== 1 || !(attr(direct[0], "class") ?? "").split(/\s+/u).includes("next_avail_item"))
      throw schemaError("The public availability list changed structure");
    return direct[0];
  });
  if (all.filter(node => (attr(node, "class") ?? "").split(/\s+/u).includes("next_avail_item")).length !== rows.length)
    throw schemaError("The public availability list has unowned rows");
  return rows.map(row => {
    if (attr(row, "data-empid") !== "0") throw schemaError("The public pooled resource identity changed");
    return decodeWall(attr(row, "data-time") ?? "");
  });
}

/** Inert projection of the selected public rental only. No session or list data survives. */
export function projectUSchedulePublicConfiguration(html: string, sourceUrl: string): USchedulePublicConfiguration | undefined {
  const tenant = uschedulePublicTenant(sourceUrl);
  if (!tenant || Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) return;
  try {
    const rental = selectedRental(html);
    pooledRows(html);
    const result = simulatorPublicConfigurationSchema.safeParse({ family: "USCHEDULE", tenant,
      serviceId: rental.serviceId, durationMinutes: 60, availabilityKind: "OPAQUE_POOLED" });
    return result.success && result.data.family === "USCHEDULE" ? result.data : undefined;
  } catch { return undefined; }
}

function validDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return false;
  const value = new Date(`${date}T12:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}
function decodeWall(value: string) {
  const match = /^(\d{2})(\d{2})(\d{4})(\d{2})(\d{2})$/u.exec(value);
  if (!match) throw schemaError("The public simulator start encoding changed");
  const [, month, day, year, hour, minute] = match;
  const date = `${year}-${month}-${day}`;
  if (!validDate(date) || Number(hour) > 23 || Number(minute) > 59) throw schemaError("The public simulator start is invalid");
  const wall = `${date}T${hour}:${minute}:00`;
  return { value, date, wall, order: Date.parse(`${wall}Z`) };
}
function venueInstant(wall: string, zone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const local = (candidate: Date) => {
    const parts = Object.fromEntries(formatter.formatToParts(candidate).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  };
  const wallUtc = Date.parse(`${wall}Z`);
  if (!Number.isFinite(wallUtc)) throw schemaError("The simulator start is invalid");
  const offsets = new Set<number>();
  // Sample a bounded window around the wall clock to include both sides of
  // ordinary and half-hour transitions without trusting one guessed offset.
  for (let minutes = -36 * 60; minutes <= 36 * 60; minutes += 30) {
    const probe = new Date(wallUtc + minutes * 60_000);
    offsets.add(Date.parse(`${local(probe)}Z`) - probe.getTime());
  }
  const matches = [...offsets].map(offset => new Date(wallUtc - offset))
    .filter(candidate => local(candidate) === wall);
  if (matches.length !== 1)
    throw schemaError("The simulator start is ambiguous in the venue timezone");
  return matches[0];
}
function listing(html: string, expectedServiceId: string) {
  const rental = selectedRental(html);
  if (rental.serviceId !== expectedServiceId) throw sourceError("The public simulator rental changed identity");
  const all = elements(parse(html));
  const times = pooledRows(html);
  if (times.some((time, index) => index > 0 && time.order <= times[index - 1].order))
    throw schemaError("The public availability list is not strictly ordered");
  const more = all.filter(node => attr(node, "id") === "more_next_avail");
  if (more.length > 1) throw schemaError("The public continuation control is ambiguous");
  const cursors: string[] = [];
  for (const script of all.filter(node => node.tagName === "script")) {
    const body = "childNodes" in script ? script.childNodes.map(node => "value" in node ? node.value : "").join("") : "";
    if (!body.includes("lastAvailTime")) continue;
    if (Buffer.byteLength(body, "utf8") > 20_000) throw schemaError("The public continuation declaration is unbounded");
    let program: ReturnType<typeof parseScript>;
    try { program = parseScript(body, { ecmaVersion: "latest", sourceType: "script" }); }
    catch { throw schemaError("The public continuation declaration changed"); }
    for (const statement of program.body) {
      if (statement.type === "ExpressionStatement" && statement.expression.type === "AssignmentExpression" &&
          statement.expression.operator === "=" && statement.expression.left.type === "Identifier" &&
          statement.expression.left.name === "lastAvailTime") {
        const value = statement.expression.right;
        if (value.type !== "Literal" || typeof value.value !== "string" || !/^\d{12}$/u.test(value.value))
          throw schemaError("The public continuation cursor is invalid");
        cursors.push(value.value);
      }
      if (statement.type !== "VariableDeclaration") continue;
      for (const declaration of statement.declarations) {
        if (declaration.id.type !== "Identifier" || declaration.id.name !== "lastAvailTime") continue;
        if (declaration.init?.type !== "Literal" || typeof declaration.init.value !== "string" ||
            !/^\d{12}$/u.test(declaration.init.value)) throw schemaError("The public continuation cursor is invalid");
        cursors.push(declaration.init.value);
      }
    }
  }
  if (cursors.length !== 1 || cursors[0] !== times.at(-1)!.value) throw schemaError("The public continuation cursor changed");
  return { times, cursor: cursors[0], morePresent: more.length === 1 };
}
async function bounded(response: Response, ceiling: number) {
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared > ceiling || !response.body) throw schemaError("The public simulator response exceeds its size limit");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength;
      if (size > ceiling) throw schemaError("The public simulator response exceeds its size limit"); chunks.push(next.value); }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)); }
  catch { throw schemaError("The public simulator response encoding changed"); }
}
async function publicResponse(url: URL, init: RequestInit, expectedType: string, ceiling: number,
  fetchImpl: typeof fetch, signal: AbortSignal) {
  let response: Response;
  try { response = await fetchWithProviderTimeout(url, { ...init, signal, redirect: "manual", cache: "no-store", credentials: "omit" }, fetchImpl); }
  catch { throw new SimulatorAvailabilityError("HTTP_ERROR", "The public simulator scheduler could not be reached", true); }
  if (response.status !== 200 || response.headers.has("location")) throw new SimulatorAvailabilityError("HTTP_ERROR",
    "The public simulator scheduler did not return a direct public response", response.status === 429 || response.status >= 500,
    response.status, response.headers.get("retry-after"));
  if (response.url && response.url !== url.href) throw sourceError("The public simulator scheduler changed destination");
  const sentCookie = new Headers(init.headers).get("cookie");
  if (sentCookie && response.headers.getSetCookie().some(row => row.split(";", 1)[0] !== sentCookie))
    throw sourceError("The anonymous public scheduler session changed");
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== expectedType)
    throw schemaError("The public simulator scheduler returned an unexpected response type");
  return { response, body: await bounded(response, ceiling) };
}
async function refresh(url: URL, cookie: string, name: "start_date" | "more_next_avail", value: string,
  fetchImpl: typeof fetch, signal: AbortSignal) {
  const endpoint = new URL(`${url.pathname}/changefield`, url.origin);
  const { body } = await publicResponse(endpoint, { method: "POST", headers: { Accept: "application/json",
    "Content-Type": "application/json", Cookie: cookie, Origin: url.origin, Referer: url.href,
    "X-Requested-With": "XMLHttpRequest" }, body: JSON.stringify([{ Name: name, Value: value }]) },
  "application/json", MAX_JSON_BYTES, fetchImpl, signal);
  let payload: unknown;
  try { payload = JSON.parse(body); } catch { throw schemaError("The public simulator refresh response is invalid"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).length !== 1 || (payload as { code?: unknown }).code !== "refresh")
    throw schemaError("The public simulator query did not return a safe refresh");
}

/** Reads only the selected default 60-minute public rental in a new anonymous session. */
export async function fetchUScheduleAvailability(input: SimulatorAvailabilityInput,
  fetchImpl: typeof fetch = fetch): Promise<SimulatorAvailabilityResult> {
  const tenant = uschedulePublicTenant(input.offering.bookingUrl);
  const metadata = metadataSchema.safeParse(input.offering.providerMetadata);
  if (!tenant || !metadata.success || metadata.data.tenant !== tenant || input.offering.providerFamilyKey !== "USCHEDULE" ||
      input.offering.active !== true || input.offering.publicAccessStatus !== "PUBLIC" ||
      input.offering.maxPartySize !== null || input.offering.supportedDurationsMinutes.length !== 1 ||
      input.offering.supportedDurationsMinutes[0] !== 60) throw sourceError("The reviewed USchedule rental source is not bound");
  if (!validDate(input.date) || !Number.isInteger(input.partySize) || input.partySize !== 1 || !input.offering.id ||
      input.offering.id.length > 200) throw new SimulatorAvailabilityError("INVALID_REQUEST", "The simulator request is invalid");
  if (input.durationMinutes !== 60) throw new SimulatorAvailabilityError("UNSUPPORTED_DURATION", "Only the selected public one-hour rental is verified");
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone }).format(); }
  catch { throw new SimulatorAvailabilityError("INVALID_REQUEST", "The venue timezone is invalid"); }
  const url = new URL(input.offering.bookingUrl), signal = AbortSignal.timeout(25_000);
  const first = await publicResponse(url, { method: "GET", headers: { Accept: "text/html" } },
    "text/html", MAX_HTML_BYTES, fetchImpl, signal);
  if (selectedRental(first.body).serviceId !== metadata.data.serviceId) throw sourceError("The public simulator service changed identity");
  const cookies = first.response.headers.getSetCookie();
  if (cookies.length !== 1) throw sourceError("The anonymous public scheduler session changed");
  const cookie = cookies[0].split(";", 1)[0];
  if (!/^ASP\.NET_SessionId=[A-Za-z0-9]{8,100}$/u.test(cookie)) throw sourceError("The anonymous public scheduler session changed");
  const dateValue = `${input.date.slice(5, 7)}/${input.date.slice(8, 10)}/${input.date.slice(0, 4)}`;
  await refresh(url, cookie, "start_date", dateValue, fetchImpl, signal);
  const slots: SimulatorAvailabilitySlot[] = [];
  const seen = new Set<string>();
  let previousOrder = -Infinity;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const dated = await publicResponse(url, { method: "GET", headers: { Accept: "text/html", Cookie: cookie } },
      "text/html", MAX_HTML_BYTES, fetchImpl, signal);
    const current = listing(dated.body, metadata.data.serviceId);
    if (current.times.at(-1)!.order <= previousOrder) throw schemaError("The public continuation did not advance");
    let crossedDate = false;
    for (const time of current.times) {
      if (time.date < input.date) throw schemaError("The public continuation regressed");
      if (time.order > Date.parse(`${input.date}T00:00:00Z`) + 60 * 86_400_000)
        throw schemaError("The public continuation left its bounded calendar horizon");
      if (time.order <= previousOrder) {
        if (!seen.has(time.value)) throw schemaError("The public continuation introduced an older start");
        continue;
      }
      if (seen.has(time.value)) throw schemaError("The public continuation repeated a new start");
      if (time.date > input.date) { crossedDate = true; continue; }
      if (crossedDate) throw schemaError("The public availability page reordered dates");
      const startsAt = venueInstant(time.wall, input.timeZone);
      const nextWall = new Date(time.order + 60 * 60_000).toISOString().slice(0, 19);
      const endsAt = venueInstant(nextWall, input.timeZone);
      if (endsAt.getTime() - startsAt.getTime() !== 60 * 60_000) throw schemaError("The public rental crosses an ambiguous timezone transition");
      slots.push({ sourceId: `uschedule:${input.offering.id}:${metadata.data.serviceId}:${startsAt.toISOString()}`,
        offeringId: input.offering.id, resourceId: "ANY", productId: metadata.data.serviceId,
        startsAt, endsAt, maxPartySize: null, bookingUrl: input.offering.bookingUrl });
      seen.add(time.value);
    }
    previousOrder = current.times.at(-1)!.order;
    if (crossedDate) return { slots, complete: true, observedAt: new Date(), evidenceUrl: url.href };
    if (!current.morePresent || page === MAX_PAGES - 1) throw schemaError("The public date list was not completely observed");
    await refresh(url, cookie, "more_next_avail", current.cursor, fetchImpl, signal);
  }
  throw schemaError("The public date list was not completely observed");
}
