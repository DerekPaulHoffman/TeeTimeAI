import { z } from "zod";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";

export const SIMULATOR_RESEARCH_MAX_READS = 6;
const safeUrl = z.string().refine(value => Boolean(getSafeCustomerBookingUrl(value)));
const observation = z.object({
  source: z.enum(["official", "booking", "link"]), requestedUrl: safeUrl, sourceUrl: safeUrl,
  observedAt: z.string().datetime(), httpStatus: z.number().int().min(0).max(599), rendered: z.boolean(),
  outcome: z.enum(["READ", "NETWORK_FAILED", "CAPACITY_BUSY"]),
}).strict();
const stateSchema = z.object({
  version: z.literal(1), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  readCount: z.number().int().min(0).max(SIMULATOR_RESEARCH_MAX_READS),
  history: z.array(observation).max(SIMULATOR_RESEARCH_MAX_READS),
  links: z.array(safeUrl).max(30), bookingLinks: z.array(safeUrl).max(30).default([]), linkBaseUrl: safeUrl.nullable(),
  inFlight: z.object({ requestId: z.string().uuid(), startedAt: z.string().datetime(), expiresAt: z.string().datetime(),
    source: z.enum(["official", "booking", "link"]), url: safeUrl, rendered: z.boolean() }).strict().nullable(),
}).strict().refine(state => state.history.length + (state.inFlight ? 1 : 0) === state.readCount && state.bookingLinks.every(url => state.links.includes(url)));
export type SimulatorResearchState = z.infer<typeof stateSchema>;

export function readSimulatorResearchState(value: unknown, fingerprint: string): SimulatorResearchState {
  if (value === undefined) return { version: 1, sourceFingerprint: fingerprint, readCount: 0, history: [], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null };
  if (typeof value === "object" && value && !Array.isArray(value) && !("version" in value)) {
    // The previous reader persisted one bounded source observation without navigation.
    const legacy = z.object({ source: z.enum(["official", "booking"]), requestedUrl: safeUrl, sourceUrl: safeUrl,
      observedAt: z.string().datetime(), httpStatus: z.number().int().min(100).max(599), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/i) }).strict().parse(value);
    return { version: 1, sourceFingerprint: legacy.sourceFingerprint, readCount: 1, history: [{
      source: legacy.source, requestedUrl: legacy.requestedUrl, sourceUrl: legacy.sourceUrl,
      observedAt: legacy.observedAt, httpStatus: legacy.httpStatus, rendered: false, outcome: "READ",
    }], links: [], bookingLinks: [], linkBaseUrl: null, inFlight: null };
  }
  return stateSchema.parse(value);
}

export function selectSimulatorResearchTarget(input: {
  state: SimulatorResearchState; officialUrl: string | null; bookingUrl: string | null;
  source?: "official" | "booking"; linkIndex?: number; rendered: boolean; now: Date;
  priorFailedRoutes?: { url: string; rendered: boolean }[];
}): { source: "official" | "booking" | "link"; url: string; rendered: boolean } {
  const { state } = input;
  if (state.inFlight) throw new Error("Simulator source research is already in flight; inspect its original attempt before continuing.");
  if (state.readCount >= SIMULATOR_RESEARCH_MAX_READS) throw new Error("The bounded simulator source research budget is exhausted.");
  const source = input.linkIndex !== undefined ? "link" : input.source;
  const raw = source === "link" ? state.links[input.linkIndex! - 1] : source === "official" ? input.officialUrl : input.bookingUrl;
  const url = getSafeCustomerBookingUrl(raw);
  if (!source || !url || (source === "link" && (!Number.isInteger(input.linkIndex) || input.linkIndex! < 1 || !state.linkBaseUrl))) throw new Error("The selected owned simulator source or link is unavailable.");
  if (source === "link") {
    const previous = state.history.at(-1);
    if (!previous || previous.httpStatus < 200 || previous.httpStatus >= 300 || new Date(previous.observedAt).getTime() < input.now.getTime() - 30 * 60_000 ||
        new URL(url).origin !== new URL(state.linkBaseUrl!).origin &&
          !(state.bookingLinks.includes(url) && /\b(?:book(?:ing)?|reserv(?:e|ation)|appointments?|calendar)\b/i.test(new URL(url).pathname) ||
            input.bookingUrl && new URL(url).hostname === new URL(input.bookingUrl).hostname)) {
      throw new Error("The selected link is not a fresh same-site page or official booking handoff.");
    }
    if (new URL(url).origin === new URL(state.linkBaseUrl!).origin && state.history.filter(entry => entry.source === "link" && new URL(entry.requestedUrl).origin === new URL(url).origin).length >= 2) throw new Error("The bounded same-site research depth is exhausted.");
  }
  const destinations = new Set(state.history.filter(entry => entry.source === "booking" || entry.source === "link" && input.officialUrl && new URL(entry.requestedUrl).origin !== new URL(input.officialUrl).origin).map(entry => entry.requestedUrl));
  if (source !== "official" && !destinations.has(url) && destinations.size >= 3) throw new Error("The bounded simulator booking destination budget is exhausted.");
  if (state.history.some(entry => entry.requestedUrl === url && entry.rendered === input.rendered)) throw new Error("Use a different simulator source research route; the identical route was already attempted.");
  if (input.priorFailedRoutes?.some(entry => entry.url === url && entry.rendered === input.rendered)) throw new Error("An unchanged structural source failure needs a different research route or materially changed source.");
  return { source, url, rendered: input.rendered };
}

export function assertSimulatorResearchFallbackBeforeRetry(state: SimulatorResearchState, bookingUrl: string | null) {
  if (state.inFlight) throw new Error("Finish or reconcile the original source research attempt before retry.");
  const failedIndex = state.history.map(entry => entry.source === "official" && !entry.rendered && entry.outcome !== "CAPACITY_BUSY" && (entry.httpStatus < 200 || entry.httpStatus >= 300)).lastIndexOf(true);
  const failed = state.history[failedIndex];
  if (!failed || failed.httpStatus === 429) return;
  if (!state.history.slice(failedIndex + 1).some(entry => entry.rendered && entry.requestedUrl === failed.requestedUrl ||
    (entry.source === "booking" || entry.source === "link") && entry.requestedUrl !== failed.requestedUrl && (!bookingUrl || entry.requestedUrl === bookingUrl || entry.source === "link"))) {
    throw new Error("A failed simulator homepage needs a distinct official booking read or a bounded rendered official-site read before retry.");
  }
}
