import { createAddressPinnedPublicFetchTransport } from "@/lib/automation/address-pinned-public-fetch";
import { runWithProviderRequestLease } from "@/lib/automation/provider-request-lease";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";
import { bindFiveIronLocation, fiveIronAvailabilitySchema, fiveIronMetadataSchema, parseFiveIronSource, type FiveIronSource, type FiveIronMetadata } from "./five-iron-source";
import type { AccessExecutionInput, AccessExecutionResult } from "./recipe";
import { requestFamilyForUrl } from "./request-family";
type Dependencies = { fetch?: typeof fetch; deadlineAt?: Date; now?: () => Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }> };
const origin = "https://api.booking.fiveirongolf.com";
function reader(source: FiveIronSource, deps: Dependencies) {
  if (!parseFiveIronSource(source.bookingUrl)) throw Error("INVALID_ADAPTER_SOURCE");
  const now = deps.now ?? (() => new Date()), remaining = Math.min(30_000, (deps.deadlineAt?.getTime() ?? Infinity) - now().getTime());
  if (remaining <= 0) throw Error("DEADLINE_EXCEEDED");
  const controller = new AbortController(), signal = AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]);
  const queue = createSimulatorBrowserRequestQueue(deps.requestLease ?? runWithProviderRequestLease, signal);
  let count = 0;
  return { close: () => { controller.abort(); queue.dispose(); }, read: async (url: string) => {
    const parsed = new URL(url);
    if (parsed.origin !== origin || !["/locations", "/appointments/available/simulator"].includes(parsed.pathname) || ++count > 2) throw Error("UNSCOPED_ADAPTER_REQUEST");
    const transport = deps.fetch ?? createAddressPinnedPublicFetchTransport({ parseUrl: value => {
      if (value !== url) throw Error("UNSCOPED_ADAPTER_REQUEST"); return new URL(value);
    }, maxResponseBytes: 2_000_000, timeoutMs: 15_000, redirectLimit: 0 });
    return queue.run(requestFamilyForUrl(url), async () => {
      const response = await transport(url, { method: "GET", credentials: "omit", redirect: "manual", cache: "no-store", signal,
        headers: { accept: "application/json", "X-Variant": "fiveIron" } });
      try {
        if (response.redirected || response.url && response.url !== url) throw Error("ADAPTER_TRANSPORT_FAILED");
        if ([401, 403].includes(response.status)) throw Error("ACCESS_REQUIRED");
        if (response.status === 429) throw Error("PROVIDER_THROTTLED");
        if (response.status !== 200 || !/application\/json/iu.test(response.headers.get("content-type") ?? "")) throw Error("ADAPTER_TRANSPORT_FAILED");
        const bytes: Uint8Array[] = []; let size = 0; const body = response.body?.getReader();
        if (!body) throw Error("ADAPTER_TRANSPORT_FAILED");
        try { while (true) { const part = await body.read(); if (part.done) break; size += part.value.byteLength;
          if (size > 2_000_000) throw Error("ADAPTER_RESPONSE_LIMIT"); bytes.push(part.value); } }
        finally { await body.cancel().catch(() => {}); }
        try { return JSON.parse(Buffer.concat(bytes).toString("utf8")) as unknown; } catch { throw Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED"); }
      } finally { await response.body?.cancel().catch(() => {}); }
    });
  } };
}
export async function inspectFiveIron(source: FiveIronSource, deps: Dependencies): Promise<FiveIronMetadata> {
  const session = reader(source, deps);
  try { return bindFiveIronLocation(source, await session.read(origin + "/locations")); } finally { session.close(); }
}
export async function executeFiveIron(source: FiveIronSource, metadata: FiveIronMetadata, input: AccessExecutionInput,
  deps: Dependencies & { toInstant: (value: unknown, input: AccessExecutionInput) => Date }): Promise<AccessExecutionResult["slots"]> {
  const saved = fiveIronMetadataSchema.parse(metadata), duration = input.durationMinutes;
  if (input.timeZone !== saved.timeZone || input.timeZone !== source.timeZone || !duration || duration % 30 || duration > 240) throw Error("ADAPTER_TARGET_MISMATCH");
  const session = reader(source, deps);
  try {
    const current = bindFiveIronLocation(source, await session.read(origin + "/locations"));
    if (JSON.stringify(current) !== JSON.stringify(saved)) throw Error("ADAPTER_CONFIGURATION_CHANGED");
    const url = new URL("/appointments/available/simulator", origin);
    // One ordinary public bay; saved golfer count does not parameterize rental availability.
    for (const [key, value] of Object.entries({ locationId: saved.locationId, partySize: "1", startDateTime: input.date, endDateTime: input.date })) url.searchParams.set(key, value);
    const parsed = fiveIronAvailabilitySchema.safeParse(await session.read(url.href));
    if (!parsed.success) throw Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
    const seen = new Set<string>(), slots: AccessExecutionResult["slots"] = [];
    for (const row of parsed.data) {
      if (!row.time.startsWith(input.date + "T") || seen.has(row.time) || new Set(row.availabilities.map(a => a.staffId)).size !== row.availabilities.length ||
        row.availabilities.some(a => new Set(a.durations.map(d => d.duration)).size !== a.durations.length)) throw Error("ADAPTER_AVAILABILITY_SCHEMA_CHANGED");
      seen.add(row.time);
      // A duration must belong to one actual bay. Never join partial bay intervals.
      if (!row.availabilities.some(a => a.durations.some(d => d.duration === duration))) continue;
      const start = deps.toInstant(row.time.slice(0, 19), input), end = new Date(start.getTime() + duration * 60_000);
      slots.push({ sourceId: `five-iron:${saved.locationId}:${row.time.slice(0, 16)}:${duration}`,
        startsAt: start.toISOString(), endsAt: end.toISOString(), availableSpots: 1, capacity: null,
        bookingUrl: parseFiveIronSource(source.bookingUrl)!.bookingUrl, productId: `five-iron:simulator:${duration}` });
    }
    return slots;
  } finally { session.close(); }
}
