import { accessExecutionInputSchema, type AccessExecutionInput, type AccessExecutionResult } from "./recipe";
import { inspectMindbodyPublicRentalCatalog, mindbodyAppointmentMetadataSchema, parseMindbodyAppointmentSource,
  readMindbodyPublicAppointmentGrid, validateMindbodyAppointmentSource, type MindbodyAppointmentMetadata, type MindbodyAppointmentSource,
  type MindbodyCatalogEvidence, type MindbodyGridEvidence } from "./mindbody-appointment-grid";
import type { DiscoveryBrowserSessionDependencies } from "./browser-session";

type Factory = typeof import("./browser-session").createCourseDiscoveryBrowserSession;
export type MindbodyAppointmentSession = Pick<Awaited<ReturnType<Factory>>, "execute" | "close"> & {
  readMindbodyPublicCatalog(): Promise<MindbodyCatalogEvidence>;
  readMindbodyPublicGrid(): Promise<MindbodyGridEvidence>;
};
export type MindbodyAppointmentReaderDeps = {
  now?: () => Date; deadlineAt?: Date; localCapabilities?: readonly string[]; requestedInput?: AccessExecutionInput;
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
  /** Controller test seam, never durable metadata, a model action, or uploaded evidence. */
  createSession?: (input: Parameters<Factory>[0], deps: Parameters<Factory>[1]) => Promise<MindbodyAppointmentSession>;
};
function fail(code: string): never { throw new Error(code); }
function requestContext(source: MindbodyAppointmentSource, value: AccessExecutionInput | undefined, deps: MindbodyAppointmentReaderDeps) {
  if (!deps.localCapabilities?.includes("LOCAL_CHROME")) fail("LOCAL_CHROME_REQUIRED");
  if (!parseMindbodyAppointmentSource(source.bookingUrl)) fail("MINDBODY_SOURCE_INVALID");
  validateMindbodyAppointmentSource(source);
  if (!value) fail("MINDBODY_REQUEST_CONTEXT_REQUIRED");
  const input = accessExecutionInputSchema.parse(value);
  if (input.timeZone !== source.timeZone || input.durationMinutes === undefined) fail("ADAPTER_TARGET_MISMATCH");
  return input as AccessExecutionInput & { durationMinutes: number };
}
async function withCatalog<T>(source: MindbodyAppointmentSource, requested: AccessExecutionInput | undefined,
  deps: MindbodyAppointmentReaderDeps, work: (session: MindbodyAppointmentSession, observation: ReturnType<typeof inspectMindbodyPublicRentalCatalog>,
    input: AccessExecutionInput & { durationMinutes: number }, deadline: number) => Promise<T>) {
  const input = requestContext(source, requested, deps), realNow = Date.now();
  const deadline = Math.min(realNow + 90_000, deps.deadlineAt?.getTime() ?? Infinity);
  if (!Number.isFinite(deadline) || deadline <= realNow) fail("DEADLINE_EXCEEDED");
  let session: MindbodyAppointmentSession | undefined, primary: unknown;
  try {
    const loaded = deps.createSession ? undefined : await import("./browser-session");
    const create = deps.createSession ?? loaded?.createCourseDiscoveryBrowserSession ??
      (loaded as unknown as { default?: { createCourseDiscoveryBrowserSession?: Factory } })?.default?.createCourseDiscoveryBrowserSession;
    if (!create) fail("MINDBODY_NATIVE_CAPTURE_UNAVAILABLE");
    const lease = deps.requestLease;
    const requestLease: DiscoveryBrowserSessionDependencies["requestLease"] = lease && (async <T>(family: string, work: () => Promise<T>) => {
      const result = await lease(family, work);
      return result.acquired ? { acquired: true, value: await result.value } : { acquired: false };
    });
    session = await create({ initialUrls: [source.bookingUrl], venueOfficialUrl: source.officialUrl, venueName: source.venueName,
      venueAddress: source.venueAddress, timeZone: source.timeZone, deadlineAt: new Date(deadline), requestedInput: structuredClone(input) },
      { browserTransport: "NATIVE_CHROME", fixedReaderProfile: "MINDBODY_APPOINTMENTS", localCapabilities: ["LOCAL_CHROME"], ...(requestLease ? { requestLease } : {}) });
    const opening = await session.execute({ id: 1, action: "open", url: source.bookingUrl });
    if (opening.accessRequirementObserved || opening.navigationStatus === 401 || opening.navigationStatus === 403) fail("ACCESS_REQUIRED");
    if (opening.nativeFirstFatal) fail(opening.nativeFirstFatal.code);
    const observed = inspectMindbodyPublicRentalCatalog(source, await session.readMindbodyPublicCatalog());
    if (input.durationMinutes !== observed.metadata.durationMinutes || input.players > observed.metadata.capacity) fail("ADAPTER_TARGET_MISMATCH");
    if (Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
    return await work(session, observed, input, deadline);
  } catch (error) { primary = error; throw error; }
  finally {
    try { await session?.close(); } catch (error) { if (primary === undefined) throw error; }
  }
}

export async function inspectMindbodyAppointments(source: MindbodyAppointmentSource, requestedInput: AccessExecutionInput | undefined,
  deps: MindbodyAppointmentReaderDeps = {}): Promise<MindbodyAppointmentMetadata> {
  return withCatalog(source, requestedInput ?? deps.requestedInput, deps, async (_session, observation) => observation.metadata);
}

export async function executeMindbodyAppointments(source: MindbodyAppointmentSource, adapter: MindbodyAppointmentMetadata,
  target: { courseId: string; kind?: string; offeringId?: string }, requestedInput: AccessExecutionInput,
  deps: MindbodyAppointmentReaderDeps = {}): Promise<AccessExecutionResult["slots"]> {
  requestContext(source, requestedInput, deps);
  const saved = mindbodyAppointmentMetadataSchema.parse(adapter);
  if (!target.courseId || !target.offeringId?.trim() || target.kind !== undefined && target.kind !== "SIMULATOR" ||
      saved.studioId !== parseMindbodyAppointmentSource(source.bookingUrl)?.studioId || saved.timeZone !== source.timeZone ||
      requestedInput.durationMinutes !== saved.durationMinutes || requestedInput.players > saved.capacity) fail("ADAPTER_TARGET_MISMATCH");
  return withCatalog(source, requestedInput, deps, async (session, observation, input, deadline) => {
    if (JSON.stringify(saved) !== JSON.stringify(observation.metadata)) fail("ADAPTER_CONFIGURATION_CHANGED");
    const evidence = await session.readMindbodyPublicGrid();
    if (Date.now() >= deadline) fail("DEADLINE_EXCEEDED");
    const result = readMindbodyPublicAppointmentGrid(source, observation, input, evidence);
    if (!result.complete) fail(result.reason ?? "MINDBODY_GRID_INCOMPLETE");
    const now = (deps.now ?? (() => new Date()))();
    return result.slots.filter(slot => new Date(slot.startsAt) > now).map(slot => ({
      sourceId: [saved.studioId, saved.categoryId, saved.serviceId, saved.durationMinutes, slot.resourceId, slot.startsAt].join(":"), startsAt: slot.startsAt, endsAt: slot.endsAt,
      availableSpots: 1, capacity: slot.capacity, resourceId: slot.resourceId, productId: saved.serviceId, bookingUrl: source.bookingUrl,
    }));
  });
}
