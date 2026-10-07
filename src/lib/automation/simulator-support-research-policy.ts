import { z } from "zod";
import { getSafeCustomerBookingUrl } from "@/lib/email/customer-booking-url";
import { readSafeSimulatorSupportFailure, type SimulatorSupportFailure } from "./simulator-support-failure";

export const SIMULATOR_RESEARCH_MAX_READS = 6;
export const SIMULATOR_RESEARCH_SOURCE_NAMES = ["official", "booking", "booking-root", "evidence"] as const;
export type SimulatorResearchSource = (typeof SIMULATOR_RESEARCH_SOURCE_NAMES)[number];
const researchSource = z.enum([...SIMULATOR_RESEARCH_SOURCE_NAMES, "link"]);
const safeUrl = z.string().refine(value => Boolean(getSafeCustomerBookingUrl(value)));
const safeFailure = z.custom<SimulatorSupportFailure>(value => readSafeSimulatorSupportFailure(value) !== null)
  .transform(value => readSafeSimulatorSupportFailure(value)!);
const publicReadEvidence = z.object({
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  accessControlsObserved: z.literal(true),
  accessControls: z.array(z.enum(["CAPTCHA_OR_CHALLENGE", "ACCOUNT_REQUIRED", "QUEUE"])).max(3),
  method: z.enum(["HTTP", "BROWSER"]), renderComplete: z.boolean().optional(),
}).strict();
const observation = z.object({
  source: researchSource, requestedUrl: safeUrl, sourceUrl: safeUrl,
  observedAt: z.string().datetime(), httpStatus: z.number().int().min(0).max(599), rendered: z.boolean(),
  outcome: z.enum(["READ", "NETWORK_FAILED", "CAPACITY_BUSY", "HARD_FAILED"]),
  requestId: z.string().uuid().optional(), failure: safeFailure.optional(),
  publicReadEvidence: publicReadEvidence.optional(),
}).strict().refine(entry => entry.outcome === "HARD_FAILED" ? Boolean(entry.requestId && entry.failure && entry.httpStatus === 0) :
  !entry.failure || Boolean(entry.requestId && entry.httpStatus === 0 && ["NETWORK_FAILED", "CAPACITY_BUSY"].includes(entry.outcome)))
  .refine(entry => !entry.publicReadEvidence || Boolean(entry.requestId && entry.outcome === "READ" &&
    entry.publicReadEvidence.method === (entry.rendered ? "BROWSER" : "HTTP")));
const stateSchema = z.object({
  version: z.literal(1), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/i),
  readCount: z.number().int().min(0).max(SIMULATOR_RESEARCH_MAX_READS),
  history: z.array(observation).max(SIMULATOR_RESEARCH_MAX_READS),
  links: z.array(safeUrl).max(30), bookingLinks: z.array(safeUrl).max(30).default([]), linkBaseUrl: safeUrl.nullable(),
  bookingLinkRoles: z.array(z.object({ url: safeUrl, observedAt: z.string().datetime() }).strict()).max(30).optional(),
  lastRecoveredFailureRequestId: z.string().uuid().optional(),
  inFlight: z.object({ requestId: z.string().uuid(), startedAt: z.string().datetime(), expiresAt: z.string().datetime(),
    source: researchSource, url: safeUrl, rendered: z.boolean() }).strict().nullable(),
}).strict().refine(state => state.history.length + (state.inFlight ? 1 : 0) === state.readCount && state.bookingLinks.every(url => state.links.includes(url)) &&
  (!state.bookingLinkRoles || new Set(state.bookingLinkRoles.map(role => role.url)).size === state.bookingLinkRoles.length &&
    state.bookingLinkRoles.every(role => state.bookingLinks.includes(role.url))));
export type SimulatorResearchState = z.infer<typeof stateSchema>;
export type SimulatorResearchBlockedRoute = { url: string; rendered: boolean; httpStatus: number };

/** Legacy reads retain unknown access evidence; only new owned settlements qualify. */
export function readSettledSimulatorPublicCheckpoint(state: SimulatorResearchState, now: Date) {
  const last = state.history.at(-1);
  if (state.inFlight || state.readCount < 1 || state.readCount >= SIMULATOR_RESEARCH_MAX_READS ||
      state.history.some(entry => entry.outcome === "HARD_FAILED" || (entry.publicReadEvidence?.accessControls.length ?? 0) > 0) || !last || last.outcome !== "READ" ||
      last.httpStatus < 200 || last.httpStatus >= 300 || !last.requestId || !last.publicReadEvidence ||
      last.publicReadEvidence.sourceFingerprint !== state.sourceFingerprint ||
      last.publicReadEvidence.accessControlsObserved !== true || last.publicReadEvidence.accessControls.length ||
      last.rendered && last.publicReadEvidence.renderComplete !== true ||
      Date.parse(last.observedAt) > now.getTime() || Date.parse(last.observedAt) < now.getTime() - 30 * 60_000) return null;
  return { observedAt: last.observedAt, requestId: last.requestId,
    publicReadEvidence: { ...last.publicReadEvidence, httpStatus: last.httpStatus } };
}

function isFreshBookingLink(state: SimulatorResearchState, url: string, now: Date) {
  if (!state.bookingLinks.includes(url)) return false;
  if (state.bookingLinkRoles !== undefined) return state.bookingLinkRoles.some(role => role.url === url &&
    Date.parse(role.observedAt) <= now.getTime() && Date.parse(role.observedAt) >= now.getTime() - 30 * 60_000);
  // Legacy roles are usable only from their current last successful receipt.
  // A subsequent successful read cannot carry them without original provenance.
  const receipt = [...state.history].reverse().find(entry => entry.sourceUrl === state.linkBaseUrl && entry.httpStatus >= 200 && entry.httpStatus < 300);
  return Boolean(receipt && Date.parse(receipt.observedAt) <= now.getTime() && Date.parse(receipt.observedAt) >= now.getTime() - 30 * 60_000);
}

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

/** One known public parent route, derived only from the exact current saved bay URL. */
function savedBookingRoot(bookingUrl: string | null) {
  const saved = getSafeCustomerBookingUrl(bookingUrl);
  const match = saved?.match(/^https:\/\/(booking\.trackmangolf\.com|(?:www\.)?yourgolfbooking\.com)\/venues\/([a-z0-9]+(?:-[a-z0-9]+)*)\/booking\/bays\/?$/u);
  if (!match) return undefined;
  return getSafeCustomerBookingUrl(`https://${match[1]}/venues/${match[2]}/booking`);
}

export function selectSimulatorResearchTarget(input: {
  state: SimulatorResearchState; officialUrl: string | null; bookingUrl: string | null; evidenceUrl?: string | null;
  source?: SimulatorResearchSource; linkIndex?: number; rendered: boolean; now: Date;
  priorFailedRoutes?: { url: string; rendered: boolean }[];
}): { source: SimulatorResearchSource | "link"; url: string; rendered: boolean } {
  const { state } = input;
  if (state.inFlight) throw new Error("Simulator source research is already in flight; inspect its original attempt before continuing.");
  if (state.readCount >= SIMULATOR_RESEARCH_MAX_READS) throw new Error("The bounded simulator source research budget is exhausted.");
  const source = input.linkIndex !== undefined ? "link" : input.source;
  const raw = source === "link" ? state.links[input.linkIndex! - 1] : source === "official" ? input.officialUrl : source === "evidence" ? input.evidenceUrl : source === "booking-root" ? savedBookingRoot(input.bookingUrl) : input.bookingUrl;
  const url = getSafeCustomerBookingUrl(raw);
  if (!source || !url || (source === "link" && (!Number.isInteger(input.linkIndex) || input.linkIndex! < 1 || !state.linkBaseUrl))) throw new Error("The selected owned simulator source or link is unavailable.");
  if (source === "evidence") {
    const official = getSafeCustomerBookingUrl(input.officialUrl);
    if (!official || new URL(url).origin !== new URL(official).origin) throw new Error("The saved evidence page must remain on the official website origin.");
    if (new URL(url).href === new URL(official).href) throw new Error("Use the original official route when the evidence page is the homepage.");
  }
  if (source === "link") {
    const previous = [...state.history].reverse().find(entry => entry.sourceUrl === state.linkBaseUrl && entry.httpStatus >= 200 && entry.httpStatus < 300);
    if (!previous || previous.httpStatus < 200 || previous.httpStatus >= 300 || new Date(previous.observedAt).getTime() < input.now.getTime() - 30 * 60_000 ||
        new URL(url).origin !== new URL(state.linkBaseUrl!).origin &&
          !(isFreshBookingLink(state, url, input.now) && /\b(?:book(?:ing)?|reserv(?:e|ation)|appointments?|calendar)\b/i.test(new URL(url).pathname) ||
            input.bookingUrl && new URL(url).hostname === new URL(input.bookingUrl).hostname)) {
      throw new Error("The selected link is not a fresh same-site page or official booking handoff.");
    }
    if (new URL(url).origin === new URL(state.linkBaseUrl!).origin && state.history.filter(entry => entry.source === "link" && new URL(entry.requestedUrl).origin === new URL(url).origin).length >= 2) throw new Error("The bounded same-site research depth is exhausted.");
  }
  const destinations = new Set(state.history.filter(entry => entry.source === "booking" || entry.source === "booking-root" || entry.source === "link" && input.officialUrl && new URL(entry.requestedUrl).origin !== new URL(input.officialUrl).origin).map(entry => entry.requestedUrl));
  if (source !== "official" && source !== "evidence" && !destinations.has(url) && destinations.size >= 3) throw new Error("The bounded simulator booking destination budget is exhausted.");
  if (state.history.some(entry => entry.requestedUrl === url && entry.rendered === input.rendered)) throw new Error("Use a different simulator source research route; the identical route was already attempted.");
  if (input.priorFailedRoutes?.some(entry => entry.url === url && entry.rendered === input.rendered)) throw new Error("An unchanged structural source failure needs a different research route or materially changed source.");
  return { source, url, rendered: input.rendered };
}

/** Suggested commands retain the same saved-source, budget and failed-route fences. */
export function getSimulatorResearchGuide(input: {
  state: SimulatorResearchState; officialUrl: string | null; bookingUrl: string | null; evidenceUrl?: string | null;
  now: Date; priorFailedRoutes: SimulatorResearchBlockedRoute[];
}) {
  const roleLinks = input.state.links.flatMap((url, index) => isFreshBookingLink(input.state, url, input.now) ? [index] : []);
  const genericLinks = input.state.links.flatMap((_, index) => roleLinks.includes(index) ? [] : [index]);
  const routes: Array<{ source?: SimulatorResearchSource; linkIndex?: number; rendered: boolean }> = [
    { source: "booking" as const, rendered: false }, { source: "booking" as const, rendered: true },
    ...roleLinks.flatMap(index => [{ linkIndex: index + 1, rendered: false }, { linkIndex: index + 1, rendered: true }]),
    { source: "booking-root" as const, rendered: false }, { source: "booking-root" as const, rendered: true },
    ...genericLinks.flatMap(index => [{ linkIndex: index + 1, rendered: false }, { linkIndex: index + 1, rendered: true }]),
    { source: "evidence" as const, rendered: false }, { source: "evidence" as const, rendered: true },
    { source: "official" as const, rendered: false }, { source: "official" as const, rendered: true },
  ];
  const seen = new Set<string>();
  const suggestedReads = routes.filter(route => {
    try {
      const selected = selectSimulatorResearchTarget({ ...input, ...route });
      const key = `${new URL(selected.url).href}:${selected.rendered}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    } catch { return false; }
  });
  return { readsRemaining: SIMULATOR_RESEARCH_MAX_READS - input.state.readCount,
    inFlight: Boolean(input.state.inFlight), suggestedReads,
    priorBlockedRoutes: input.priorFailedRoutes.map(route => ({ ...route })) };
}

/** Route identity is the public URL plus rendered/plain mode, not URL alone. */
export function getSimulatorResearchRetryGuide(input: {
  state: SimulatorResearchState; officialUrl: string | null; bookingUrl: string | null; evidenceUrl?: string | null;
  now: Date; priorFailedRoutes: SimulatorResearchBlockedRoute[];
}) {
  const { state } = input;
  if (state.inFlight) throw new Error("Finish or reconcile the original source research attempt before retry.");
  const researchGuide = getSimulatorResearchGuide(input);
  type Route = (typeof researchGuide.suggestedReads)[number];
  type CloseoutReason = "HARD_FAILURE" | "READ_BUDGET_EXHAUSTED" | "PROVIDER_BACKOFF" |
    "NO_ALLOWED_RESEARCH_ROUTES" | "NO_ELIGIBLE_BOOKING_ROUTES" | null;
  const result = (nextEligibleBookingRead: Route | null, skipHomepageFallback: boolean, closeoutReason: CloseoutReason) => ({
    researchGuide, nextEligibleBookingRead, bookingResearchRequired: Boolean(nextEligibleBookingRead), skipHomepageFallback, closeoutReason,
  });
  const latest = state.history.at(-1);
  if (latest?.outcome === "HARD_FAILED" && latest.requestId !== state.lastRecoveredFailureRequestId) return result(null, true, "HARD_FAILURE");
  if (state.readCount >= SIMULATOR_RESEARCH_MAX_READS) return result(null, true, "READ_BUDGET_EXHAUSTED");
  const recognizedNetwork = latest?.outcome === "NETWORK_FAILED" && latest.httpStatus === 0 && latest.requestId &&
    latest.failure?.stage === "PUBLIC_READ" && latest.failure.category === "NETWORK" && readSafeSimulatorSupportFailure(latest.failure);
  if (latest?.outcome === "CAPACITY_BUSY" || latest?.httpStatus === 429 || recognizedNetwork ||
      latest?.outcome === "READ" && latest.httpStatus >= 500 && latest.httpStatus <= 599) return result(null, true, "PROVIDER_BACKOFF");
  if (researchGuide.suggestedReads.length === 0) return result(null, true, "NO_ALLOWED_RESEARCH_ROUTES");
  const official = getSafeCustomerBookingUrl(input.officialUrl);
  const booking = getSafeCustomerBookingUrl(input.bookingUrl);
  const distinctSavedBooking = Boolean(booking && (!official || new URL(booking).href !== new URL(official).href));
  const next = researchGuide.suggestedReads.find(route => {
    const selected = selectSimulatorResearchTarget({ ...input, ...route });
    return selected.source === "booking" && distinctSavedBooking || selected.source === "booking-root" || selected.source === "link" &&
      isFreshBookingLink(state, selected.url, input.now) && (!official || new URL(selected.url).href !== new URL(official).href);
  });
  if (next) return result(next, false, null);
  // Do not let the older homepage assertion demand a saved booking route whose
  // URL/mode is already consumed or denied by current source/budget guards.
  return result(null, distinctSavedBooking, distinctSavedBooking ? "NO_ELIGIBLE_BOOKING_ROUTES" : null);
}

export function assertSimulatorResearchFallbackBeforeRetry(state: SimulatorResearchState, bookingUrl: string | null, officialUrl?: string | null) {
  if (state.inFlight) throw new Error("Finish or reconcile the original source research attempt before retry.");
  // The original hard-failed operation must exit; a later owned retry may close
  // the incomplete attempt without disguising it as a public observation.
  if (state.history.at(-1)?.outcome === "HARD_FAILED" || state.readCount >= SIMULATOR_RESEARCH_MAX_READS) return;
  if (officialUrl && getSimulatorResearchGuide({ state, officialUrl, bookingUrl, now: new Date(), priorFailedRoutes: [] }).suggestedReads.length === 0) return;
  // Rate limits and shared-provider capacity require backoff rather than more requests.
  if (state.history.at(-1)?.outcome === "CAPACITY_BUSY" || state.history.at(-1)?.httpStatus === 429) return;
  const failedIndex = state.history.map(entry => entry.source === "official" && !entry.rendered && entry.outcome !== "CAPACITY_BUSY" && (entry.httpStatus < 200 || entry.httpStatus >= 300)).lastIndexOf(true);
  const failed = state.history[failedIndex];
  if (!failed || failed.httpStatus === 429) return;
  const savedBooking = getSafeCustomerBookingUrl(bookingUrl);
  if (savedBooking && new URL(savedBooking).href !== new URL(failed.requestedUrl).href) {
    if (!state.history.some(entry => entry.outcome !== "CAPACITY_BUSY" && new URL(entry.requestedUrl).href === new URL(savedBooking).href)) {
      throw new Error("A failed simulator homepage needs its distinct saved official booking read before retry; a failed rendered homepage does not replace it.");
    }
    return;
  }
  if (!state.history.slice(failedIndex + 1).some(entry => entry.rendered && entry.requestedUrl === failed.requestedUrl ||
    (entry.source === "booking" || entry.source === "link") && entry.requestedUrl !== failed.requestedUrl && (!bookingUrl || entry.requestedUrl === bookingUrl || entry.source === "link"))) {
    throw new Error("A failed simulator homepage needs a distinct official booking read or a bounded rendered official-site read before retry.");
  }
}
