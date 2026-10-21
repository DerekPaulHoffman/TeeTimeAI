import { getTimeZoneOffsetMinutes } from "@/lib/timezones";
import { accessExecutionInputSchema, type AccessExecutionInput, type AccessExecutionResult } from "./recipe";
import { ezlinksAvailabilityBody, ezlinksMetadataSchema, parseEzLinksAvailability, parseEzLinksConfiguration,
  parseEzLinksSource, validateEzLinksIdentity, verifyEzLinksReadContract, type EzLinksMetadata, type EzLinksSource } from "./ezlinks-source";
import type { DiscoveryBrowserSessionDependencies } from "./browser-session";

type Factory = typeof import("./browser-session").createCourseDiscoveryBrowserSession;
type Session = Pick<Awaited<ReturnType<Factory>>, "execute" | "readEzLinksConfiguration" | "readEzLinksAvailability" | "close"> & {
  readEzLinksReadContract(): Promise<unknown>;
};
export type EzLinksDependencies = {
  now?: () => Date; deadlineAt?: Date;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
  /** Test-only controller seam. Never part of a recipe, tool argument or durable
   * metadata. Production dynamically imports the guarded native controller. */
  createSession?: (input: Parameters<Factory>[0], dependencies: Parameters<Factory>[1]) => Promise<Session>;
};
function fail(code: string): never { throw new Error(code); }
async function withConfiguration<T>(source: EzLinksSource, deps: EzLinksDependencies,
  work: (session: Session, configuration: ReturnType<typeof parseEzLinksConfiguration>) => Promise<T>): Promise<T> {
  validateEzLinksIdentity(source);
  // Availability clocks may be injected by tests. Browser lifetime must remain
  // bound to the real trusted wall clock and the original enclosing deadline.
  const realNow = Date.now(), deadline = Math.min(realNow + 120_000, deps.deadlineAt?.getTime() ?? Infinity);
  if (!Number.isFinite(deadline) || deadline <= realNow) fail("DEADLINE_EXCEEDED");
  let session: Session | undefined;
  try {
    // BrowserSession imports the typed inspector. Load only after this module
    // is initialized; no eager BrowserSession/adapter module cycle is created.
    const create = deps.createSession ?? (await import("./browser-session")).createCourseDiscoveryBrowserSession;
    const lease = deps.requestLease;
    const requestLease: DiscoveryBrowserSessionDependencies["requestLease"] = lease && (async <T>(family: string, work: () => Promise<T>) => {
      const result = await lease(family, work);
      return result.acquired ? { acquired: true, value: await result.value } : { acquired: false };
    });
    session = await create({ initialUrls: [source.bookingUrl], venueOfficialUrl: source.officialUrl,
      venueName: source.venueName, venueAddress: source.venueAddress, timeZone: source.timeZone, deadlineAt: new Date(deadline) },
      { browserTransport: "NATIVE_CHROME", ...(requestLease ? { requestLease } : {}) });
    const opening = await session.execute({ id: 1, action: "open", url: source.bookingUrl });
    if (opening.accessRequirementObserved || opening.navigationStatus === 401 || opening.navigationStatus === 403) fail("ACCESS_REQUIRED");
    const configuration = parseEzLinksConfiguration(await session.readEzLinksConfiguration(), source);
    verifyEzLinksReadContract(await session.readEzLinksReadContract());
    if (Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
    return await work(session, configuration);
  } finally { await session?.close(); }
}

export async function inspectEzLinks(source: EzLinksSource, deps: EzLinksDependencies): Promise<EzLinksMetadata> {
  return withConfiguration(source, deps, async (_session, configuration) => configuration.metadata);
}

function localParts(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
/** A naive course-local timestamp is accepted only when exactly one instant
 * round-trips in the canonical IANA zone. Gaps/folds never silently normalize. */
export function ezlinksLocalInstant(value: string, timeZone: string): Date {
  const naive = Date.parse(`${value}Z`);
  if (!Number.isFinite(naive)) fail("INVALID_SLOT_TIME");
  const offsets = new Set([-36, 0, 36].map(hours => getTimeZoneOffsetMinutes(new Date(naive + hours * 3_600_000), timeZone)));
  const candidates = [...offsets].map(offset => new Date(naive - offset * 60_000)).filter(instant => localParts(instant, timeZone) === value);
  if (candidates.length !== 1) fail("AMBIGUOUS_OR_INVALID_LOCAL_TIME");
  return candidates[0];
}

export async function executeEzLinks(source: EzLinksSource, metadata: EzLinksMetadata, _target: { courseId: string },
  rawInput: AccessExecutionInput, deps: EzLinksDependencies): Promise<AccessExecutionResult["slots"]> {
  const saved = ezlinksMetadataSchema.parse(metadata), input = accessExecutionInputSchema.parse(rawInput);
  if (input.timeZone !== source.timeZone || input.durationMinutes !== undefined || input.players > 4) fail("ADAPTER_TARGET_MISMATCH");
  if (saved.tenant !== parseEzLinksSource(source.bookingUrl)?.tenant) fail("ADAPTER_SOURCE_MISMATCH");
  return withConfiguration(source, deps, async (session, configuration) => {
    if (JSON.stringify(configuration.metadata) !== JSON.stringify(saved)) fail("ADAPTER_CONFIGURATION_CHANGED");
    const body = ezlinksAvailabilityBody(configuration, input);
    // This controller-only operation is exact same-document/init-bound native
    // POST/search with p07 false; page-provided fetch bodies are never proof.
    const value = await session.readEzLinksAvailability(body);
    const slots = parseEzLinksAvailability(value, configuration, input, value => ezlinksLocalInstant(value, input.timeZone));
    const now = (deps.now ?? (() => new Date()))();
    return slots.filter(slot => new Date(slot.startsAt) > now).map(slot => ({ ...slot, bookingUrl: source.bookingUrl }));
  });
}
