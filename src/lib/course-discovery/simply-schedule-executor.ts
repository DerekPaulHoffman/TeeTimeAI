import { createHash } from "node:crypto";
import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { parseSimplyScheduleBootstrap, parseSimplyScheduleSlots, publicSsaUrl, simplyScheduleFrame, simplyScheduleMetadataSchema,
  verifySimplyScheduleOfficial, SSA_PUBLIC_CLIENT_SHA256, type SimplyScheduleMetadata, type SimplyScheduleSource } from "./simply-schedule-public";
import type { AccessExecutionInput } from "./recipe";
import { accessExecutionInputSchema } from "./recipe";

type Dependencies = { fetch?: typeof fetch; deadlineAt?: Date; signal?: AbortSignal; now?: () => Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
function fail(code: string): never { throw Error(code); }
const sameHost = (a: string, b: string) => new URL(a).hostname.replace(/^www\./u, "") === new URL(b).hostname.replace(/^www\./u, "");
function reader(source: SimplyScheduleSource, deps: Dependencies) {
  if (!publicSsaUrl(source.officialUrl) || !publicSsaUrl(source.bookingUrl) || new URL(source.officialUrl).pathname !== "/" ||
      !sameHost(source.officialUrl, source.bookingUrl) || !source.venueAddress) fail("ADAPTER_IDENTITY_MISSING");
  const end = Math.min(deps.deadlineAt?.getTime() ?? Infinity, Date.now() + 120000);
  if (!Number.isFinite(end) || end <= Date.now()) fail("DEADLINE_EXCEEDED");
  const signal = AbortSignal.any([AbortSignal.timeout(end - Date.now()), ...(deps.signal ? [deps.signal] : [])]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  let requests = 0, totalBytes = 0;
  const read = async (url: string, kind: "ROOT" | "HTML" | "CLIENT" | "JSON", nonce?: string, redirect = false): Promise<string> => {
    signal.throwIfAborted();
    if (++requests > 8) fail("SSA_REQUEST_LIMIT");
    const u = new URL(url), origin = new URL(source.bookingUrl).origin;
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash ||
        (kind === "ROOT" ? !publicSsaUrl(url) || !sameHost(url, source.officialUrl) || u.pathname !== "/" : u.origin !== origin)) fail("SSA_UNSCOPED_READ");
    const limit = kind === "CLIENT" ? 700000 : 600000;
    const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl: value => {
      if (value !== url) fail("SSA_UNSCOPED_READ"); return new URL(value);
    }, maxResponseBytes: limit, timeoutMs: 15000, redirectLimit: 0 });
    const reply = await queue.run("SIMPLY_SCHEDULE_APPOINTMENTS", async () => {
      const response = await transport(url, { method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", signal,
        headers: { accept: kind === "JSON" ? "application/json" : kind === "CLIENT" ? "application/javascript, text/javascript" : "text/html",
          ...(nonce ? { "X-PUBLIC-Nonce": nonce } : {}) } });
      try {
        if (response.redirected || response.url && response.url !== url) fail("SSA_TRANSPORT_FAILED");
        if (kind === "ROOT" && !redirect && [301, 302, 307, 308].includes(response.status)) {
          const next = new URL(response.headers.get("location") ?? "", url);
          if (!response.headers.get("location") || !publicSsaUrl(next.href) || !sameHost(next.href, source.officialUrl) || next.pathname !== "/") fail("SSA_UNSCOPED_READ");
          return { location: next.href };
        }
        if (response.status !== 200) fail("SSA_PUBLIC_READ_FAILED");
        const mime = response.headers.get("content-type") ?? "";
        if (!(kind === "JSON" ? /^application\/json(?:;|$)/iu : kind === "CLIENT" ? /^(?:application|text)\/javascript(?:;|$)/iu : /^text\/html(?:;|$)/iu).test(mime)) fail("SSA_RESPONSE_TYPE_CHANGED");
        const body = await response.text(), bytes = Buffer.byteLength(body); totalBytes += bytes;
        if (bytes > limit || totalBytes > 2500000) fail("SSA_RESPONSE_LIMIT");
        signal.throwIfAborted(); return { body };
      } finally { await response.body?.cancel().catch(() => {}); }
    });
    if ("location" in reply) return read(reply.location!, "ROOT", undefined, true);
    return reply.body!;
  };
  return { read, close: () => queue.dispose() };
}
async function inspect(source: SimplyScheduleSource, durationMinutes: number, deps: Dependencies, optional: boolean) {
  const reads = reader(source, deps);
  try {
    const parent = await reads.read(source.bookingUrl, "HTML"), frame = simplyScheduleFrame(parent, source.bookingUrl);
    if (!frame) { reads.close(); if (optional) return null; return fail("SSA_PUBLIC_SOURCE_CHANGED"); }
    const root = await reads.read(source.officialUrl, "ROOT");
    verifySimplyScheduleOfficial(root, source);
    // A golf-playing rental must be offered publicly on the official page;
    // the plugin's generic simulator label alone cannot establish golf use.
    if (!/\bgolf\b/iu.test(parent.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, ""))) fail("SSA_PUBLIC_GOLF_RENTAL_UNVERIFIED");
    const embed = await reads.read(frame, "HTML"), config = parseSimplyScheduleBootstrap(embed, frame, source, durationMinutes);
    const client = await reads.read(config.clientUrl, "CLIENT");
    if (createHash("sha256").update(client).digest("hex") !== SSA_PUBLIC_CLIENT_SHA256) fail("SSA_PUBLIC_CLIENT_UNSUPPORTED");
    return { reads, config };
  } catch (error) { reads.close(); throw error; }
}
/** Only the freshly observed same-origin parent may select the plugin. */
export async function inspectSimplySchedule(source: SimplyScheduleSource, durationMinutes: number, deps: Dependencies) {
  const result = await inspect(source, durationMinutes, deps, true);
  if (!result) return null;
  try { return result.config.metadata; } finally { result.reads.close(); }
}
export async function executeSimplySchedule(source: SimplyScheduleSource, saved: SimplyScheduleMetadata, input: AccessExecutionInput, deps: Dependencies) {
  input = accessExecutionInputSchema.parse(input);
  if (source.timeZone !== input.timeZone || !input.durationMinutes) fail("ADAPTER_TARGET_MISMATCH");
  const result = await inspect(source, input.durationMinutes, deps, false);
  if (!result) return fail("SSA_PUBLIC_SOURCE_CHANGED");
  try {
    const { config, reads } = result;
    if (JSON.stringify(config.metadata) !== JSON.stringify(simplyScheduleMetadataSchema.parse(saved))) fail("ADAPTER_CONFIGURATION_CHANGED");
    // Match the reviewed public client's UTC date range and one-any-resource
    // GET. Never invoke /async, create an appointment, or save booking tokens.
    const date = new Date(input.date + "T00:00:00Z"), min = new Date(date), max = new Date(date);
    min.setUTCDate(min.getUTCDate() - 1); max.setUTCDate(max.getUTCDate() + 2);
    const url = new URL(`${config.apiRoot}/appointment_types/${saved.appointmentTypeId}/availability`);
    url.searchParams.set("start_date_min", min.toISOString().slice(0, 10)); url.searchParams.set("start_date_max", max.toISOString().slice(0, 10));
    url.searchParams.set("query_args[resources_required][0][resource_group_id]", String(saved.resourceGroupId));
    url.searchParams.set("query_args[resources_required][0][resource_id]", "0");
    url.searchParams.set("query_args[resources_required][0][resource_quantity]", "1");
    const response = await reads.read(url.href, "JSON", config.publicNonce);
    let value: unknown; try { value = JSON.parse(response); } catch { return fail("SSA_AVAILABILITY_UNVERIFIED"); }
    return parseSimplyScheduleSlots(value, saved, input, deps.now?.() ?? new Date());
  } finally { result.reads.close(); }
}
