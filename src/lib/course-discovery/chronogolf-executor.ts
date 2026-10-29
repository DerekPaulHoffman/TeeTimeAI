import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { accessExecutionInputSchema, isSafeBrowserAssetUrl, isSafeRecipeUrl, type AccessExecutionInput, type AccessExecutionResult } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
import { chronogolfAvailabilityPageSchema, chronogolfMetadataSchema, parseChronogolfPagination, parseChronogolfProfile,
  parseChronogolfSource, chronogolfOfficialHostMismatch, verifyChronogolfReadClients, chronogolfRecipeBookingUrl, type ChronogolfIdentitySource, type ChronogolfMetadata } from "./chronogolf-source";

import type { OfficialIdentityPage } from "./teeitup-official-identity";
import type { NativeOfficialPageReader } from "./native-official-page-reader";
import { freshNativeCanonicalRootDocument } from "./native-official-page-attestation";
import type { DiscoveryTrustedContext } from "./trusted-context";

type Deps = { fetch?: typeof fetch; now?: () => Date; deadlineAt?: Date;
  localCapabilities?: readonly "LOCAL_CHROME"[]; officialIdentityPage?: OfficialIdentityPage; readNativeOfficialPage?: NativeOfficialPageReader;
  trustedContext?: DiscoveryTrustedContext;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
const MAX_PAGES = 10, MAX_ROWS = 500, MAX_RESPONSE_BYTES = 2_000_000, MAX_TOTAL_BYTES = 16_000_000;
function fail(code: string): never { throw new Error(code); }

function createReader(source: ChronogolfIdentitySource, deps: Deps) {
  const context = parseChronogolfSource(source.bookingUrl);
  if (!context || !source.venueAddress || !isSafeRecipeUrl(source.officialUrl)) fail("ADAPTER_IDENTITY_MISSING");
  const clock = deps.now ?? (() => new Date()), deadline = Math.min(clock().getTime() + 90_000, deps.deadlineAt?.getTime() ?? Infinity);
  const remaining = deadline - clock().getTime();
  if (!(remaining > 0)) fail("DEADLINE_EXCEEDED");
  const cancellation = new AbortController(), signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(remaining)]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  const allowed = new Set([context!.profileUrl]); let requests = 0, bytes = 0;
  const read = async (url: string, kind: "html" | "json" | "script", profileRedirect = false): Promise<{ text: string; headers: Headers; url: string }> => {
    if (!allowed.has(url) || ++requests > MAX_PAGES + 5) fail("ADAPTER_REQUEST_LIMIT");
    const parseUrl = (value: string) => {
      if (value !== url || !allowed.has(value) || !(isSafeRecipeUrl(value) || kind === "script" && isSafeBrowserAssetUrl(value, "script", "GET")) || new URL(value).origin !== "https://www.chronogolf.com") fail("UNSCOPED_ADAPTER_REQUEST");
      return new URL(value);
    };
    const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl, maxResponseBytes: MAX_RESPONSE_BYTES,
      timeoutMs: 15_000, redirectLimit: 0 });
    return queue.run(requestFamilyForUrl(url), async () => {
      signal.throwIfAborted(); if (clock().getTime() >= deadline) fail("DEADLINE_EXCEEDED");
      const response = await transport(url, { method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", signal,
        headers: { accept: kind === "html" ? "text/html" : kind === "script" ? "application/javascript,text/javascript" : "application/json", referer: context!.profileUrl,
          "user-agent": "TeeTimeSpot/1.0 (+https://teetimespot.com)" } });
      let consumed = false;
      try {
      if (response.redirected || response.url && response.url !== parseUrl(url).href) fail("ADAPTER_TRANSPORT_FAILED");
      if (response.status === 429) fail("PROVIDER_THROTTLED");
      if ([401, 403].includes(response.status)) fail("ACCESS_REQUIRED");
      if (profileRedirect && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        const next = location ? parseChronogolfSource(new URL(location, url).href) : null;
        if (!next || next.widgetUrl) fail("ADAPTER_PROFILE_REDIRECT_INVALID");
        return { text: "", headers: response.headers, url: next!.profileUrl };
      }
      if (response.status !== 200) fail("ADAPTER_TRANSPORT_FAILED");
      const contentType = response.headers.get("content-type") ?? "";
      if (!(kind === "html" ? /^text\/html(?:;|$)/iu : kind === "script" ? /^(?:text|application)\/(?:x-)?javascript(?:;|$)/iu : /^application\/json(?:;|$)/iu).test(contentType)) fail("ADAPTER_RESPONSE_INVALID");
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (!Number.isFinite(declared) || declared < 0 || declared > MAX_RESPONSE_BYTES) fail("ADAPTER_RESPONSE_LIMIT");
      const buffer = await response.arrayBuffer(); consumed = true; bytes += buffer.byteLength;
      if (buffer.byteLength > MAX_RESPONSE_BYTES || bytes > MAX_TOTAL_BYTES) fail("ADAPTER_RESPONSE_LIMIT");
      signal.throwIfAborted(); if (clock().getTime() >= deadline) fail("DEADLINE_EXCEEDED");
      return { text: Buffer.from(buffer).toString("utf8"), headers: response.headers, url };
      } finally { if (!consumed) { try { await response.body?.cancel(); } catch { /* Preserve the bounded primary failure. */ } } }
    });
  };
  const configuration = async () => {
    let url = context!.profileUrl; const seen = new Set<string>();
    for (let hops = 0; hops <= 2; hops++) {
      if (seen.has(url)) fail("ADAPTER_PROFILE_REDIRECT_INVALID"); seen.add(url); allowed.add(url);
      const document = await read(url, "html", true);
      if (!document.text && document.url !== url) { if (hops === 2) fail("ADAPTER_PROFILE_REDIRECT_INVALID"); url = document.url; continue; }
      if (!document.text) fail("ADAPTER_PROFILE_REDIRECT_INVALID");
      let metadata: ChronogolfMetadata;
      try { metadata = parseChronogolfProfile(document.text, url, source, undefined, deps.trustedContext); }
      catch (error) {
        if (!chronogolfOfficialHostMismatch(error)) throw error;
        if (!deps.localCapabilities?.includes("LOCAL_CHROME")) fail("LOCAL_CHROME_REQUIRED");
        signal.throwIfAborted(); if (clock().getTime() >= deadline) fail("DEADLINE_EXCEEDED");
        let page = deps.officialIdentityPage;
        if (!page || !freshNativeCanonicalRootDocument(page, source.officialUrl)) {
          const factory: NativeOfficialPageReader = deps.readNativeOfficialPage ?? (async (identity, pageUrl, end) => {
            const loaded = await import("./native-official-page-reader");
            const native = typeof loaded.readNativeOfficialIdentityPage === "function" ? loaded :
              (loaded as unknown as { default: typeof loaded }).default;
            const requestLease: typeof runWithProviderRequestLease | undefined = deps.requestLease ? async (family, work) => {
              const reply = await deps.requestLease!(family, work);
              return reply.acquired ? { acquired: true, value: await reply.value } : { acquired: false };
            } : undefined;
            return native.readNativeOfficialIdentityPage(identity, pageUrl, end, { requestLease });
          });
          // No provider data lease is held while this separately owned native
          // reader re-earns the ordinary canonical root and its visible edge.
          page = await factory(source, source.officialUrl, new Date(deadline));
        }
        signal.throwIfAborted(); if (clock().getTime() >= deadline) fail("DEADLINE_EXCEEDED");
        metadata = parseChronogolfProfile(document.text, url, source, page, deps.trustedContext);
      }
      const bodies: Record<string, string> = {};
      for (const client of metadata.clients) { allowed.add(client.url); bodies[client.url] = (await read(client.url, "script")).text; }
      verifyChronogolfReadClients(metadata, bodies);
      return metadata;
    }
    return fail("ADAPTER_PROFILE_REDIRECT_INVALID");
  };
  return { configuration, read, allow: (url: string) => { allowed.add(url); }, close: () => { cancellation.abort(); queue.dispose(); } };
}

export async function inspectChronogolf(source: ChronogolfIdentitySource, deps: Deps): Promise<ChronogolfMetadata> {
  const reader = createReader(source, deps);
  try { return await reader.configuration(); } finally { reader.close(); }
}

function localParts(value: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}:${parts.second}` };
}

/** Public client evidence, 2026-10-20: ordinary TeeTimeView sends every course
 * UUID and the union of every bookableHoles when no purchased-round filter is
 * selected. 1710 client SHA256 3d7f020bc8c0a795d8132b1951cc2be2c50ada2983458c9aa98df02e5631b340;
 * 1805 serializer SHA256 78bb211875897af6f24bbec9f39600786543482678d32d7dedc0335ccacaae78.
 * The fixed GET reproduces those public filters, not the widget's selected18.
 * default_price is only one offered round, so no round/price is invented for the
 * returned all-round time. Physical layout remains the separate Course fact. */
export async function executeChronogolf(source: ChronogolfIdentitySource, metadata: ChronogolfMetadata, _target: { courseId: string },
  input: AccessExecutionInput, deps: Deps): Promise<AccessExecutionResult["slots"]> {
  const saved = chronogolfMetadataSchema.parse(metadata), request = accessExecutionInputSchema.parse(input);
  if (request.timeZone !== saved.timeZone || request.timeZone !== source.timeZone || request.durationMinutes !== undefined) fail("ADAPTER_TARGET_MISMATCH");
  const reader = createReader(source, deps);
  try {
    const current = await reader.configuration();
    if (JSON.stringify(current) !== JSON.stringify(saved)) fail("ADAPTER_CONFIGURATION_CHANGED");
    const courses = new Map(saved.courses.map(course => [course.uuid, course]));
    const courseIds = saved.courses.map(course => course.uuid), holes = [...new Set(saved.courses.flatMap(course => course.bookableHoles))].sort((a, b) => a - b);
    // The pinned profile/TeeTimeView reads date and step=teetimes from its
    // ordinary public query. This preserves the existing adapter's direct link.
    const booking = chronogolfRecipeBookingUrl(source.bookingUrl, saved, request.date);
    const results: AccessExecutionResult["slots"] = [], ids = new Set<number>(), uuids = new Set<string>();
    let expectedTotal: number | undefined, expectedPerPage: number | undefined, rowsRead = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = new URL("/marketplace/v2/teetimes", "https://www.chronogolf.com");
      for (const [key, value] of Object.entries({ start_date: request.date, free_slots: String(request.players), course_ids: courseIds.join(","), holes: holes.join(","), page: String(page) }))
        url.searchParams.set(key, value);
      reader.allow(url.href);
      const response = await reader.read(url.href, "json"), pagination = parseChronogolfPagination(response.headers);
      if (pagination.total > MAX_ROWS || Math.ceil(pagination.total / pagination.perPage) > MAX_PAGES) fail("ADAPTER_RESPONSE_LIMIT");
      if (expectedTotal !== undefined && (pagination.total !== expectedTotal || pagination.perPage !== expectedPerPage)) fail("ADAPTER_PAGINATION_CHANGED");
      expectedTotal = pagination.total; expectedPerPage = pagination.perPage;
      let value: unknown; try { value = JSON.parse(response.text); } catch { fail("ADAPTER_AVAILABILITY_SCHEMA_CHANGED"); }
      const parsed = chronogolfAvailabilityPageSchema.safeParse(value);
      if (!parsed.success) fail("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
      const rows = parsed.data.teetimes, expectedCount = Math.min(pagination.perPage, Math.max(0, pagination.total - (page - 1) * pagination.perPage));
      if (rows.length !== expectedCount || parsed.data.status === "sold_out" && (rows.length !== 0 || pagination.total !== 0)) fail("ADAPTER_PAGINATION_UNVERIFIED");
      for (const row of rows) {
        if (ids.has(row.id) || uuids.has(row.uuid)) fail("ADAPTER_DUPLICATE_SLOT");
        ids.add(row.id); uuids.add(row.uuid); rowsRead++;
        const course = courses.get(row.course.uuid), start = new Date(row.starts_at), local = localParts(start, request.timeZone);
        if (!course || row.course.id !== course.id || row.course.name !== course.name || row.course.holes !== course.layoutHoles ||
            JSON.stringify([...row.course.bookable_holes].sort((a, b) => a - b)) !== JSON.stringify(course.bookableHoles) ||
            !course.bookableHoles.includes(row.default_price.bookable_holes) || row.default_price.player_type_id !== saved.publicPlayerTypeId ||
            !/^Public\*?$/iu.test(row.default_price.affiliation_type.trim()) ||
            row.hole > course.layoutHoles || row.date !== request.date || local.date !== row.date || local.time !== `${row.start_time}:00`)
          fail("ADAPTER_SLOT_MISMATCH");
        if (row.frozen || request.players < row.min_player_size || request.players > row.max_player_size ||
            row.start_time < request.startTime || row.start_time >= request.endTime) continue;
        results.push({ sourceId: `chronogolf-${row.uuid}`, startsAt: start.toISOString(), availableSpots: row.max_player_size,
          bookingUrl: booking, resourceId: `chronogolf-course:${course.uuid}` });
      }
      if (rowsRead === pagination.total) return results.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.sourceId.localeCompare(b.sourceId));
    }
    return fail("ADAPTER_PAGINATION_UNVERIFIED");
  } finally { reader.close(); }
}
