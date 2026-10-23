// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { hashAccessRecipe, isSafeRecipeUrl, parseAccessRecipe, type AccessExecutionInput } from "./recipe";

const mocks = vi.hoisted(() => ({
  db: {
    $transaction: vi.fn(), $queryRaw: vi.fn(),
    course: { findUnique: vi.fn(), updateMany: vi.fn() },
    courseOffering: { findUnique: vi.fn(), updateMany: vi.fn() },
    coursePreference: { findMany: vi.fn() },
    courseDiscoveryJob: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    courseAccessRecipe: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    courseSupportBatch: { findFirst: vi.fn() }, automationRun: { findMany: vi.fn() },
  }, pilot: vi.fn(), pilotIds: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: mocks.db }));
vi.mock("./config", () => ({ isDiscoveryPilotSearch: mocks.pilot, activeDiscoveryPilotSearchIds: mocks.pilotIds }));
import {
  activateDiscoveryRecipe, checkpointDiscoveryJob, claimNextDiscoveryJob, degradeRecipe,
  DiscoveryConflictError, ensureDiscoveryJob, ensureDiscoveryJobInTransaction, failDiscoveryJob, getActiveAccessRecipe,
  heartbeatDiscoveryJob, proposeDiscoveryRecipe, recordDiscoveryVerification, assertActiveAccessRecipeInTransaction,
} from "./service";

const now = new Date("2030-01-01T12:00:00.000Z");
const input: AccessExecutionInput = { date: "2030-01-02", timeZone: "UTC", players: 1, startTime: "09:00", endTime: "17:00" };
const recipe = parseAccessRecipe({
  schemaVersion: 1, engine: "HTTP_JSON", target: { courseId: "course1", kind: "OUTDOOR" },
  source: { officialUrl: "https://golf.example.com/", bookingUrl: "https://golf.example.com/times", venueName: "Example Golf", providerFamily: "EXAMPLE", timeZone: "UTC" },
  request: { url: "https://golf.example.com/times?date={{date}}", method: "GET" },
  permittedRoutes: [{ origin: "https://golf.example.com", path: "/times", methods: ["GET"], queryKeys: ["date"] }],
  proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, empty: { path: "empty" } },
  slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "spots" } },
});
let course: Record<string, unknown>;
let job: Record<string, unknown> | null;
let preferences: unknown[];

function result(players = 1) {
  return { status: "AVAILABLE", complete: true, observedAt: now.toISOString(), sourceUrl: recipe.source.bookingUrl,
    slots: [{ sourceId: "slot1", startsAt: "2030-01-02T10:00:00.000Z", availableSpots: players, bookingUrl: recipe.source.bookingUrl }],
    evidence: { recipeHash: hashAccessRecipe(recipe), venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } };
}
async function claimed() {
  await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" });
  return claimNextDiscoveryJob("worker-one");
}

beforeEach(() => {
  vi.resetAllMocks();
  course = { id: "course1", name: "Example Golf", website: "https://golf.example.com/", detectedBookingUrl: "https://golf.example.com/times", timeZone: "UTC",
    providerFamilyKey: "EXAMPLE", bookingMetadata: null, isPublic: true, activeAccessRecipeId: null };
  job = null;
  preferences = [{ teeSearch: { id: "search1", date: new Date("2030-01-02T00:00:00.000Z"), startTime: "09:00", endTime: "17:00", players: 1,
    mode: "OUTDOOR", durationMinutes: null, status: "ACTIVE", scheduleVersion: 1, userTimeZone: "UTC", createdAt: now,
    trafficClass: "PUBLIC", syntheticMultiCycle: false, syntheticTestWindow: null, alertGeneration: 0 } }];
  mocks.pilot.mockResolvedValue(true);
  mocks.pilotIds.mockResolvedValue(["search1"]);
  mocks.db.courseSupportBatch.findFirst.mockResolvedValue(null);
  mocks.db.automationRun.findMany.mockResolvedValue([]);
  mocks.db.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(mocks.db));
  mocks.db.$queryRaw.mockResolvedValue([{ now }]);
  mocks.db.course.findUnique.mockImplementation(async () => course);
  mocks.db.course.updateMany.mockImplementation(async ({ data }) => { Object.assign(course, data); return { count: 1 }; });
  mocks.db.courseOffering.findUnique.mockResolvedValue(null);
  mocks.db.courseOffering.updateMany.mockResolvedValue({ count: 1 });
  mocks.db.coursePreference.findMany.mockImplementation(async () => preferences);
  mocks.db.courseDiscoveryJob.findUnique.mockImplementation(async ({ where }) => where.activeTargetKey && job?.activeTargetKey !== where.activeTargetKey ? null : job);
  mocks.db.courseDiscoveryJob.findFirst.mockResolvedValue(null);
  mocks.db.courseDiscoveryJob.findMany.mockImplementation(async () => job ? [job] : []);
  mocks.db.courseDiscoveryJob.create.mockImplementation(async ({ data }) => (job = { id: "job1", ...data, attempts: 0, status: "QUEUED", firstPickedUpAt: null, deadlineAt: null, leaseToken: null, leaseExpiresAt: null }));
  mocks.db.courseDiscoveryJob.update.mockImplementation(async ({ data }) => {
    const values = { ...data };
    if (typeof values.attempts === "object") values.attempts = Number(job?.attempts) + values.attempts.increment;
    Object.assign(job!, values); return { ...job };
  });
  mocks.db.courseAccessRecipe.findFirst.mockResolvedValue(null);
  mocks.db.courseAccessRecipe.create.mockImplementation(async ({ data }) => ({ id: "recipe1", ...data }));
  mocks.db.courseAccessRecipe.update.mockResolvedValue({ id: "recipe1" });
});

describe("bounded course discovery persistence", () => {
  it("admits canonical demand on the supplied transaction without opening a nested transaction", async () => {
    const transactionCourse = { ...course, name: "Transaction-owned Golf" };
    const transactionCreate = vi.fn(async ({ data }) => ({ id: "atomic-job", ...data, status: "QUEUED", attempts: 0,
      firstPickedUpAt: null, deadlineAt: null }));
    const tx = { ...mocks.db, course: { ...mocks.db.course, findUnique: vi.fn(async () => transactionCourse) },
      courseDiscoveryJob: { ...mocks.db.courseDiscoveryJob, create: transactionCreate } } as unknown as Prisma.TransactionClient;
    const created = await ensureDiscoveryJobInTransaction(tx, { courseId: "course1", searchId: "search1" });
    expect(created).toMatchObject({ id: "atomic-job", status: "QUEUED", attempts: 0, firstPickedUpAt: null, deadlineAt: null,
      baseRecipeId: null, request: { identity: { name: "Transaction-owned Golf" }, demand: { searchId: "search1", alertGeneration: 0 }, input } });
    expect(mocks.pilot).toHaveBeenCalledWith("search1", process.env, tx);
    expect(mocks.pilotIds).toHaveBeenCalledWith(process.env, tx);
    expect(mocks.db.course.findUnique).not.toHaveBeenCalled();
    expect(mocks.db.courseDiscoveryJob.create).not.toHaveBeenCalled();
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
  });

  it("does not accept transaction admission as authorization for a non-pilot", async () => {
    mocks.pilot.mockResolvedValue(false);
    expect(await ensureDiscoveryJobInTransaction(mocks.db as unknown as Prisma.TransactionClient,
      { courseId: "course1", searchId: "search1" })).toBeNull();
    expect(mocks.db.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.db.courseDiscoveryJob.create).not.toHaveBeenCalled();
  });

  it("rechecks pilot authorization inside the ordinary wrapper transaction", async () => {
    mocks.pilot.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" })).toBeNull();
    expect(mocks.db.$transaction).toHaveBeenCalledTimes(1);
    expect(mocks.pilot).toHaveBeenLastCalledWith("search1", process.env, mocks.db);
    expect(mocks.db.courseDiscoveryJob.create).not.toHaveBeenCalled();
  });

  it("transaction admission preserves a valid active recipe instead of forcing replacement", async () => {
    const stored = { id: "active-recipe", targetKey: "course:course1", sourceFingerprint: "current", hash: hashAccessRecipe(recipe), payload: recipe };
    // Read the real current fingerprint from the first ordinary admission.
    const first = await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" });
    stored.sourceFingerprint = first!.sourceFingerprint;
    course.activeAccessRecipeId = stored.id;
    mocks.db.courseAccessRecipe.findUnique.mockResolvedValue(stored);
    mocks.db.courseDiscoveryJob.create.mockClear(); mocks.db.course.updateMany.mockClear();
    expect(await ensureDiscoveryJobInTransaction(mocks.db as unknown as Prisma.TransactionClient,
      { courseId: "course1", searchId: "search1" })).toBeNull();
    expect(mocks.db.course.updateMany).not.toHaveBeenCalled();
    expect(mocks.db.courseDiscoveryJob.create).not.toHaveBeenCalled();
  });

  it("transaction admission returns an exhausted incident without resetting its attempt or clock", async () => {
    const exhausted = { id: "old-job", status: "TIMED_OUT", attempts: 2, firstPickedUpAt: now,
      deadlineAt: new Date(now.getTime() + 900_000), completedAt: new Date(now.getTime() + 900_001) };
    mocks.db.courseDiscoveryJob.findFirst.mockResolvedValue(exhausted);
    expect(await ensureDiscoveryJobInTransaction(mocks.db as unknown as Prisma.TransactionClient,
      { courseId: "course1", searchId: "search1" })).toEqual(exhausted);
    expect(mocks.db.courseDiscoveryJob.create).not.toHaveBeenCalled();
    expect(mocks.db.courseDiscoveryJob.update).not.toHaveBeenCalled();
  });

  it("transaction admission rejects changed requested input and respects another owner", async () => {
    await expect(ensureDiscoveryJobInTransaction(mocks.db as unknown as Prisma.TransactionClient,
      { courseId: "course1", searchId: "search1", request: { target: recipe.target, identity: {
        name: "Untrusted", officialUrl: null, bookingUrl: null, timeZone: "UTC", providerFamily: null }, input: { ...input, players: 2 } } })).rejects.toBeInstanceOf(DiscoveryConflictError);
    mocks.db.courseSupportBatch.findFirst.mockResolvedValue({ id: "legacy-owner" });
    expect(await ensureDiscoveryJobInTransaction(mocks.db as unknown as Prisma.TransactionClient,
      { courseId: "course1", searchId: "search1" })).toBeNull();
    expect(mocks.db.courseDiscoveryJob.create).not.toHaveBeenCalled();
  });

  it("issues HTTPS discovery identity from raw HTTP sources through verification, activation and current reuse", async () => {
    course.website = "http://golf.example.com/";
    course.detectedBookingUrl = "http://golf.example.com/times";
    const admitted = (await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" }))!;
    expect(admitted.request).toMatchObject({ identity: { officialUrl: recipe.source.officialUrl, bookingUrl: recipe.source.bookingUrl } });
    expect(course.website).toBe("http://golf.example.com/");
    expect(course.detectedBookingUrl).toBe("http://golf.example.com/times");
    const owner = (await claimNextDiscoveryJob("http-source-worker"))!;
    expect(owner.request).toMatchObject({ identity: { officialUrl: recipe.source.officialUrl, bookingUrl: recipe.source.bookingUrl } });
    expect(owner.sourceFingerprint).toBe(admitted.sourceFingerprint);
    const candidate = await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe);
    for (const challenge of candidate.challenges) await recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!,
      challengeId: challenge.id, recipeHash: candidate.recipeHash, input: challenge.input, result: result(challenge.input.players) });
    await activateDiscoveryRecipe(owner.id, owner.leaseToken!);
    const stored = mocks.db.courseAccessRecipe.create.mock.calls.at(-1)![0].data;
    const adoptedFingerprint = mocks.db.courseAccessRecipe.update.mock.calls.at(-1)![0].data.sourceFingerprint;
    mocks.db.courseAccessRecipe.findUnique.mockResolvedValue({ id: "recipe1", ...stored, sourceFingerprint: adoptedFingerprint });
    expect(await getActiveAccessRecipe({ courseId: "course1" })).toMatchObject({ recipe });
    expect(await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" })).toBeNull();
    expect(mocks.db.courseDiscoveryJob.create).toHaveBeenCalledOnce();
    expect(course.website).toBe("http://golf.example.com/");
  });

  it("cancels raw HTTP source drift even when the issued HTTPS identity would be unchanged", async () => {
    course.website = "http://golf.example.com/";
    const owner = (await claimed())!;
    const firstPickup = owner.firstPickedUpAt, deadline = owner.deadlineAt;
    course.website = "https://golf.example.com/";
    job!.leaseExpiresAt = new Date(now.getTime() - 1);
    expect(await claimNextDiscoveryJob("changed-source-worker")).toBeNull();
    expect(job).toMatchObject({ status: "CANCELLED", outcome: "SOURCE_CHANGED", firstPickedUpAt: firstPickup, deadlineAt: deadline });
    expect(mocks.db.courseAccessRecipe.create).not.toHaveBeenCalled();
  });

  it.each(["http://127.0.0.1/", "http://user:secret@golf.example.com/", "http://golf.example.com/login", "http://golf.example.com/times?token=secret", "http://golf.example.com:80/"])(
    "retains the unsafe source %s in issued identity instead of silently replacing it with null", async raw => {
      course.website = raw;
      course.detectedBookingUrl = raw;
      const owner = (await claimed())!;
      expect(owner.request).toMatchObject({ identity: { officialUrl: raw, bookingUrl: raw } });
      expect(isSafeRecipeUrl(raw)).toBe(false);
      await expect(proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe)).rejects.toBeInstanceOf(DiscoveryConflictError);
    });

  it("deduplicates repeated demand while deriving identity and parameters from current state", async () => {
    const first = await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" });
    const second = await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" });
    expect(second?.id).toBe(first?.id);
    expect(mocks.db.courseDiscoveryJob.create).toHaveBeenCalledOnce();
    expect(first?.request).toEqual({ target: recipe.target, identity: { name: "Example Golf", officialUrl: recipe.source.officialUrl,
      bookingUrl: recipe.source.bookingUrl, timeZone: "UTC", providerFamily: "EXAMPLE" }, input, demand: { searchId: "search1", alertGeneration: 0 } });
  });

  it("does not admit non-pilot or ended demand", async () => {
    mocks.pilot.mockResolvedValueOnce(false);
    expect(await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" })).toBeNull();
    preferences = [];
    expect(await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" })).toBeNull();
    expect(mocks.db.courseDiscoveryJob.create).not.toHaveBeenCalled();
  });

  it("filters eligible pilot IDs before bounding demand and intersects an exact search", async () => {
    mocks.pilotIds.mockResolvedValue(["search1", "search2"]);
    await claimed();
    await heartbeatDiscoveryJob("job1", String(job!.leaseToken));
    expect(mocks.pilotIds).toHaveBeenCalledWith(process.env, mocks.db);
    expect(mocks.db.coursePreference.findMany.mock.calls[0][0].where.teeSearchId).toEqual({ in: ["search1"] });
    expect(mocks.db.coursePreference.findMany.mock.calls.at(-1)![0].where.teeSearchId).toEqual({ in: ["search1", "search2"] });
    mocks.pilotIds.mockResolvedValue(["search2"]);
    mocks.db.coursePreference.findMany.mockClear();
    expect(await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" })).toBeNull();
    expect(mocks.db.coursePreference.findMany).not.toHaveBeenCalled();
  });

  it("defers a pilot target already owned by a legacy responder", async () => {
    mocks.db.courseSupportBatch.findFirst.mockResolvedValue({ id: "legacy-batch" });
    expect(await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" })).toBeNull();
    expect(mocks.db.courseDiscoveryJob.create).not.toHaveBeenCalled();
  });

  it("keeps the first pickup deadline through the one allowed retry", async () => {
    const first = await claimed();
    const deadline = first!.deadlineAt;
    await failDiscoveryJob("job1", first!.leaseToken!, "TOOL_FAILURE", true);
    const second = await claimNextDiscoveryJob("worker-two");
    expect(second!.deadlineAt).toEqual(deadline);
    expect(second!.attempts).toBe(2);
    expect(second!.leaseToken).not.toBe(first!.leaseToken);
    await expect(heartbeatDiscoveryJob("job1", first!.leaseToken!)).rejects.toBeInstanceOf(DiscoveryConflictError);
    await failDiscoveryJob("job1", second!.leaseToken!, "TOOL_FAILURE", true);
    expect(job!.status).toBe("FAILED");
    expect(job!.activeTargetKey).toBeNull();
  });

  it("cancels a lost-lease job after all active demand disappears", async () => {
    await claimed();
    job!.leaseExpiresAt = new Date(now.getTime() - 1);
    preferences = [];
    expect(await claimNextDiscoveryJob("replacement")).toBeNull();
    expect(job!.status).toBe("CANCELLED");
    expect(job!.outcome).toBe("NO_ACTIVE_DEMAND");
  });

  it("times out expired jobs without resetting their deadline", async () => {
    await claimed();
    job!.deadlineAt = new Date(now.getTime() - 1);
    job!.leaseExpiresAt = new Date(now.getTime() - 1);
    expect(await claimNextDiscoveryJob("replacement")).toBeNull();
    expect(job!.status).toBe("TIMED_OUT");
  });

  it("rejects candidate source changes and unverified activation", async () => {
    const owner = await claimed();
    const wrong = { ...recipe, source: { ...recipe.source, officialUrl: "https://other.example.com/" } };
    await expect(proposeDiscoveryRecipe("job1", owner!.leaseToken!, wrong)).rejects.toBeInstanceOf(DiscoveryConflictError);
    await proposeDiscoveryRecipe("job1", owner!.leaseToken!, recipe);
    await expect(activateDiscoveryRecipe("job1", owner!.leaseToken!)).rejects.toBeInstanceOf(DiscoveryConflictError);
    expect(mocks.db.courseAccessRecipe.create).not.toHaveBeenCalled();
  });

  it("binds optional recipe addresses without changing legacy source fingerprints", async () => {
    const owner = (await claimed())!;
    const fingerprint = owner.sourceFingerprint;
    course.address = "10 Example Drive, Example, NY 12345, USA";
    expect((await heartbeatDiscoveryJob(owner.id, owner.leaseToken!)).sourceFingerprint).toBe(fingerprint);
    const bound = parseAccessRecipe({ ...recipe, source: { ...recipe.source, venueAddress: course.address } });
    await expect(proposeDiscoveryRecipe(owner.id, owner.leaseToken!, { ...bound,
      source: { ...bound.source, venueAddress: "11 Other Street" } })).rejects.toBeInstanceOf(DiscoveryConflictError);
    await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, bound);
    course.activeAccessRecipeId = "active";
    mocks.db.courseAccessRecipe.findUnique.mockResolvedValue({ id: "active", targetKey: "course:course1", sourceFingerprint: fingerprint,
      payload: bound, hash: hashAccessRecipe(bound) });
    expect(await getActiveAccessRecipe({ courseId: "course1" })).not.toBeNull();
    course.address = "12 Changed Street";
    expect(await getActiveAccessRecipe({ courseId: "course1" })).toBeNull();
    await expect(assertActiveAccessRecipeInTransaction(mocks.db as never, { courseId: "course1" }, "active")).rejects.toBeInstanceOf(DiscoveryConflictError);
    mocks.db.courseAccessRecipe.findUnique.mockResolvedValue({ id: "active", targetKey: "course:course1", sourceFingerprint: fingerprint,
      payload: recipe, hash: hashAccessRecipe(recipe) });
    expect(await getActiveAccessRecipe({ courseId: "course1" })).not.toBeNull();
  });

  it("requires trusted observed-source evidence to replace a non-null booking URL", async () => {
    course.detectedBookingUrl = recipe.source.officialUrl;
    const owner = (await claimed())!;
    await checkpointDiscoveryJob(owner.id, owner.leaseToken!, { sourceEvidence: { officialUrl: recipe.source.officialUrl, observedBookingUrl: recipe.source.bookingUrl } });
    await expect(proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe)).rejects.toBeInstanceOf(DiscoveryConflictError);
    await expect(proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe, { officialUrl: recipe.source.officialUrl,
      observedBookingUrl: "https://different.example.com/" })).rejects.toBeInstanceOf(DiscoveryConflictError);
    await expect(proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe, { officialUrl: "https://different.example.com/",
      observedBookingUrl: recipe.source.bookingUrl })).rejects.toBeInstanceOf(DiscoveryConflictError);
  });

  it("stores source correction with protected proof and reuses it across candidate retries", async () => {
    course.detectedBookingUrl = recipe.source.officialUrl;
    const owner = (await claimed())!;
    const sourceEvidence = { officialUrl: recipe.source.officialUrl, observedBookingUrl: recipe.source.bookingUrl };
    const candidate = await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe, sourceEvidence);
    expect(job!.verification).toMatchObject({ sourceEvidence });
    expect(await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe)).toEqual(candidate);
    for (const challenge of candidate.challenges) await recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!,
      challengeId: challenge.id, recipeHash: candidate.recipeHash, input: challenge.input, result: result(challenge.input.players) });
    await activateDiscoveryRecipe(owner.id, owner.leaseToken!);
    expect(course.detectedBookingUrl).toBe(recipe.source.bookingUrl);
    expect(mocks.db.courseAccessRecipe.create.mock.calls[0][0].data.verification).toMatchObject({ sourceEvidence });
  });

  it("rejects altered protected source evidence and retains the original source fence", async () => {
    course.detectedBookingUrl = recipe.source.officialUrl;
    const owner = (await claimed())!;
    const candidate = await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe,
      { officialUrl: recipe.source.officialUrl, observedBookingUrl: recipe.source.bookingUrl });
    const verification = job!.verification as { sourceEvidence: { observedBookingUrl: string } };
    verification.sourceEvidence.observedBookingUrl = "https://changed.example.com/";
    const challenge = candidate.challenges[0];
    await expect(recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: challenge.id,
      recipeHash: candidate.recipeHash, input: challenge.input, result: result() })).rejects.toBeInstanceOf(DiscoveryConflictError);
    verification.sourceEvidence.observedBookingUrl = recipe.source.bookingUrl;
    course.detectedBookingUrl = "https://changed.example.com/";
    await expect(proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe)).rejects.toBeInstanceOf(DiscoveryConflictError);
    expect(mocks.db.courseAccessRecipe.create).not.toHaveBeenCalled();
  });

  it("requires two server-issued, input-bound proofs before atomically activating", async () => {
    const owner = await claimed();
    const proposed = await proposeDiscoveryRecipe("job1", owner!.leaseToken!, recipe);
    expect(proposed.challenges[0].input.players).toBe(1);
    expect(proposed.challenges[1].input.players).toBe(2);
    for (const challenge of proposed.challenges) await recordDiscoveryVerification({ jobId: "job1", leaseToken: owner!.leaseToken!,
      challengeId: challenge.id, recipeHash: proposed.recipeHash, input: challenge.input, result: result(challenge.input.players) });
    const activated = await activateDiscoveryRecipe("job1", owner!.leaseToken!);
    expect(activated.recipeId).toBe("recipe1");
    expect(course.activeAccessRecipeId).toBe("recipe1");
    expect(job!.status).toBe("SUCCEEDED");
    expect(job!.activeTargetKey).toBeNull();
  });

  it.each([[1, 2], [2, 3], [3, 4], [4, 3], [5, 4], [20, 19]])(
    "issues the requested party %i and a neighboring outdoor party %i without changing other inputs", async (players, alternatePlayers) => {
      preferences = [{ teeSearch: { ...(preferences[0] as { teeSearch: object }).teeSearch, players } }];
      const owner = (await claimed())!;
      const candidate = await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe);
      const requested = { ...input, players };
      expect(candidate.challenges.map(challenge => challenge.input)).toEqual([requested, { ...requested, players: alternatePlayers }]);
      expect(new Set(candidate.challenges.map(challenge => challenge.id)).size).toBe(2);
      expect(candidate.challenges.every(challenge => challenge.recipeHash === candidate.recipeHash && !challenge.completed)).toBe(true);
      expect((job!.request as { input: AccessExecutionInput }).input).toEqual(requested);
    });

  it("keeps the P1 baseline mandatory and rejects an incomplete capacity proof despite a valid neighbor", async () => {
    const owner = (await claimed())!, candidate = await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe);
    expect(candidate.challenges.map(challenge => challenge.input.players)).toEqual([1, 2]);
    const [baseline, alternate] = candidate.challenges;
    await recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: alternate.id,
      recipeHash: candidate.recipeHash, input: alternate.input, result: result(2) });
    await expect(recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: baseline.id,
      recipeHash: candidate.recipeHash, input: baseline.input,
      result: { ...result(), status: "INCOMPLETE", complete: false, slots: [], evidence: { ...result().evidence,
        capacityVerified: false, reason: "PUBLIC_PARTY_RANGE_RANGE_INVALID" } } })).rejects.toBeInstanceOf(DiscoveryConflictError);
    await expect(activateDiscoveryRecipe(owner.id, owner.leaseToken!)).rejects.toBeInstanceOf(DiscoveryConflictError);
    expect(mocks.db.courseAccessRecipe.create).not.toHaveBeenCalled();
  });

  it("accepts a complete EMPTY neighboring-party proof with all existing evidence gates", async () => {
    preferences = [{ teeSearch: { ...(preferences[0] as { teeSearch: object }).teeSearch, players: 2 } }];
    const owner = (await claimed())!, candidate = await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe);
    const [baseline, alternate] = candidate.challenges;
    expect([baseline.input.players, alternate.input.players]).toEqual([2, 3]);
    await recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: baseline.id,
      recipeHash: candidate.recipeHash, input: baseline.input, result: result(2) });
    await recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: alternate.id,
      recipeHash: candidate.recipeHash, input: alternate.input, result: { ...result(3), status: "EMPTY", slots: [] } });
    expect((await activateDiscoveryRecipe(owner.id, owner.leaseToken!)).recipeId).toBe("recipe1");
  });

  it.each([-2100, 2100])("accepts fresh client proof with %ims clock skew and retains its timestamp", async offset => {
    const owner = (await claimed())!;
    const candidate = await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe);
    const challenge = candidate.challenges[0];
    const proof = { ...result(), observedAt: new Date(now.getTime() + offset).toISOString() };
    await recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: challenge.id,
      recipeHash: candidate.recipeHash, input: challenge.input, result: proof });
    expect((job!.verification as { challenges: Array<{ result?: { observedAt: string } }> }).challenges[0].result?.observedAt).toBe(proof.observedAt);
  });

  it.each([-5001, 5001])("rejects stale or excessively future proof at %ims", async offset => {
    const owner = (await claimed())!, candidate = await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe);
    const challenge = candidate.challenges[0];
    await expect(recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: challenge.id,
      recipeHash: candidate.recipeHash, input: challenge.input, result: { ...result(), observedAt: new Date(now.getTime() + offset).toISOString() } })).rejects.toBeInstanceOf(DiscoveryConflictError);
  });

  it("does not extend an expired server deadline for a clock-tolerant proof", async () => {
    const owner = (await claimed())!, candidate = await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe);
    job!.deadlineAt = new Date(now.getTime() - 1);
    await expect(recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: candidate.challenges[0].id,
      recipeHash: candidate.recipeHash, input: candidate.challenges[0].input,
      result: { ...result(), observedAt: new Date(now.getTime() - 2100).toISOString() } })).rejects.toBeInstanceOf(DiscoveryConflictError);
  });

  it("rejects wrong challenge input and immutable proof replacement", async () => {
    const owner = await claimed();
    const proposed = await proposeDiscoveryRecipe("job1", owner!.leaseToken!, recipe);
    const challenge = proposed.challenges[0];
    const base = { jobId: "job1", leaseToken: owner!.leaseToken!, challengeId: challenge.id, recipeHash: proposed.recipeHash };
    await expect(recordDiscoveryVerification({ ...base, input: { ...challenge.input, players: 3 }, result: result(3) })).rejects.toBeInstanceOf(DiscoveryConflictError);
    await recordDiscoveryVerification({ ...base, input: challenge.input, result: result() });
    expect(await recordDiscoveryVerification({ ...base, input: challenge.input, result: result() })).toEqual({ verifiedCount: 1 });
    await expect(recordDiscoveryVerification({ ...base, input: challenge.input, result: result(4) })).rejects.toBeInstanceOf(DiscoveryConflictError);
  });

  it("does not let a model checkpoint replace protected verification", async () => {
    const owner = await claimed();
    const candidate = await proposeDiscoveryRecipe("job1", owner!.leaseToken!, recipe);
    const stored = job!.verification;
    await checkpointDiscoveryJob("job1", owner!.leaseToken!, { verification: "passed", candidateHash: candidate.recipeHash });
    expect(job!.verification).toEqual(stored);
    await expect(activateDiscoveryRecipe("job1", owner!.leaseToken!)).rejects.toBeInstanceOf(DiscoveryConflictError);
  });

  it("allows simulator targets whose parent physical course is not an outdoor public course", async () => {
    course.isPublic = false;
    mocks.db.courseOffering.findUnique.mockResolvedValue({ id: "offering1", courseId: "course1", kind: "SIMULATOR", active: true, publicAccessStatus: "UNVERIFIED",
      bookingUrl: recipe.source.bookingUrl, providerFamilyKey: "EXAMPLE", providerMetadata: null, maxPartySize: 4, supportedDurationsMinutes: [60], activeAccessRecipeId: null });
    preferences = [{ teeSearch: { ...(preferences[0] as { teeSearch: object }).teeSearch, mode: "SIMULATOR", durationMinutes: 60 } }];
    const admitted = await ensureDiscoveryJob({ courseId: "course1", offeringId: "offering1", searchId: "search1" });
    expect(admitted!.targetKey).toBe("offering:offering1");
  });

  it("never clears a newer active recipe on late degradation", async () => {
    course.activeAccessRecipeId = "newer";
    expect(await degradeRecipe({ courseId: "course1" }, "older")).toBe(false);
    expect(mocks.db.course.updateMany).not.toHaveBeenCalled();
  });

  it("refuses an active recipe when its source snapshot no longer matches", async () => {
    course.activeAccessRecipeId = "recipe1";
    mocks.db.courseAccessRecipe.findUnique.mockResolvedValue({ id: "recipe1", targetKey: "course:course1", sourceFingerprint: "old", payload: recipe });
    expect(await getActiveAccessRecipe({ courseId: "course1" })).toBeNull();
  });

  it.each([
    ["malformed", { schemaVersion: 999 }],
    ["bound to another target", { ...recipe, target: { ...recipe.target, courseId: "another-course" } }],
  ])("treats a %s stored recipe as missing coverage so admission can repair it", async (_reason, payload) => {
    const admitted = await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" });
    course.activeAccessRecipeId = "invalid-recipe";
    mocks.db.courseAccessRecipe.findUnique.mockResolvedValue({ id: "invalid-recipe", targetKey: "course:course1",
      sourceFingerprint: admitted!.sourceFingerprint, hash: hashAccessRecipe(recipe), payload });
    expect(await getActiveAccessRecipe({ courseId: "course1" })).toBeNull();
    await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" });
    expect(course.activeAccessRecipeId).toBeNull();
    expect(mocks.db.course.updateMany).toHaveBeenCalledWith({ where: { id: "course1", activeAccessRecipeId: "invalid-recipe" }, data: { activeAccessRecipeId: null } });
  });

  it("still surfaces database failures while loading the active recipe", async () => {
    course.activeAccessRecipeId = "recipe1";
    mocks.db.courseAccessRecipe.findUnique.mockRejectedValue(new Error("database unavailable"));
    await expect(getActiveAccessRecipe({ courseId: "course1" })).rejects.toThrow("database unavailable");
  });

  it.each(["40001", "40P01"])("retries raw PostgreSQL concurrency failure %s without changing ownership", async code => {
    mocks.db.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("concurrent write", {
      code: "P2010", clientVersion: "7.9.1", meta: { code },
    }));
    const created = await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" });
    expect(created?.status).toBe("QUEUED");
    expect(mocks.db.$transaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry unrelated raw SQL errors", async () => {
    mocks.db.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("invalid query", {
      code: "P2010", clientVersion: "7.9.1", meta: { code: "42601" },
    }));
    await expect(ensureDiscoveryJob({ courseId: "course1", searchId: "search1" })).rejects.toMatchObject({ code: "P2010" });
    expect(mocks.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("retries a direct adapter commit conflict without consuming a job attempt", async () => {
    const error = Object.assign(new Error("TransactionWriteConflict"), {
      name: "DriverAdapterError", cause: { kind: "TransactionWriteConflict" },
    });
    mocks.db.$transaction.mockRejectedValueOnce(error);
    const created = await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" });
    expect(created).toMatchObject({ status: "QUEUED", attempts: 0, firstPickedUpAt: null });
    expect(mocks.db.$transaction).toHaveBeenCalledTimes(2);
  });

  it("bounds repeated serialization conflicts and leaves admission unchanged", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("concurrent write", { code: "P2034", clientVersion: "7.9.1" });
    mocks.db.$transaction.mockRejectedValue(error);
    await expect(ensureDiscoveryJob({ courseId: "course1", searchId: "search1" })).rejects.toBe(error);
    expect(mocks.db.$transaction).toHaveBeenCalledTimes(5);
    expect(mocks.db.courseDiscoveryJob.create).not.toHaveBeenCalled();
  });

  it("does not retry other direct adapter failures", async () => {
    const error = Object.assign(new Error("AuthenticationFailed"), { name: "DriverAdapterError", cause: { kind: "AuthenticationFailed" } });
    mocks.db.$transaction.mockRejectedValueOnce(error);
    await expect(ensureDiscoveryJob({ courseId: "course1", searchId: "search1" })).rejects.toBe(error);
    expect(mocks.db.$transaction).toHaveBeenCalledTimes(1);
  });

  it("replaces a stale active pointer with a new discovery job without deleting history", async () => {
    course.activeAccessRecipeId = "stale-recipe";
    mocks.db.courseAccessRecipe.findUnique.mockResolvedValue({ id: "stale-recipe", targetKey: "course:course1", sourceFingerprint: "old", payload: recipe });
    const created = await ensureDiscoveryJob({ courseId: "course1", searchId: "search1" });
    expect(course.activeAccessRecipeId).toBeNull();
    expect(created!.baseRecipeId).toBeNull();
    expect(mocks.db.course.updateMany).toHaveBeenCalledWith({ where: { id: "course1", activeAccessRecipeId: "stale-recipe" }, data: { activeAccessRecipeId: null } });
  });

  it("rejects a slot on another local date even with positive worker evidence flags", async () => {
    const owner = await claimed();
    const proposed = await proposeDiscoveryRecipe("job1", owner!.leaseToken!, recipe);
    const challenge = proposed.challenges[0];
    const wrong = result(); wrong.slots[0].startsAt = "2030-01-03T10:00:00.000Z";
    await expect(recordDiscoveryVerification({ jobId: "job1", leaseToken: owner!.leaseToken!, challengeId: challenge.id,
      recipeHash: proposed.recipeHash, input: challenge.input, result: wrong })).rejects.toBeInstanceOf(DiscoveryConflictError);
  });

  it("accepts a simulator ending at next midnight but rejects a later crossing", async () => {
    mocks.db.courseOffering.findUnique.mockResolvedValue({ id: "offering1", courseId: "course1", kind: "SIMULATOR", active: true,
      publicAccessStatus: "UNVERIFIED", automationEligibility: "UNKNOWN", bookingUrl: recipe.source.bookingUrl,
      providerFamilyKey: "EXAMPLE", providerMetadata: null, maxPartySize: null, supportedDurationsMinutes: [], activeAccessRecipeId: null });
    preferences = [{ teeSearch: { ...(preferences[0] as { teeSearch: object }).teeSearch, mode: "SIMULATOR", durationMinutes: 60, players: 4,
      startTime: "23:00", endTime: "24:00" } }];
    await ensureDiscoveryJob({ courseId: "course1", offeringId: "offering1", searchId: "search1" });
    const owner = (await claimNextDiscoveryJob("simulator-worker"))!;
    const simulatorRecipe = parseAccessRecipe({ ...recipe, target: { courseId: "course1", offeringId: "offering1", kind: "SIMULATOR" },
      proof: { ...recipe.proof, durationMinutes: { path: "durationMinutes" } }, slots: { ...recipe.slots, endsAt: { path: "end" } } });
    const candidate = await proposeDiscoveryRecipe(owner.id, owner.leaseToken!, simulatorRecipe);
    expect(candidate.challenges.map(challenge => challenge.input)).toEqual([
      { ...input, players: 4, startTime: "23:00", endTime: "24:00", durationMinutes: 60 },
      { ...input, date: "2030-01-03", players: 4, startTime: "23:00", endTime: "24:00", durationMinutes: 60 },
    ]);
    const challenge = candidate.challenges[0];
    const evidence = { ...result(), evidence: { ...result().evidence, recipeHash: candidate.recipeHash },
      slots: [{ sourceId: "bay", startsAt: "2030-01-02T23:30:00.000Z", endsAt: "2030-01-03T00:30:00.000Z",
        availableSpots: 1, capacity: null, bookingUrl: recipe.source.bookingUrl }] };
    const record = (value: typeof evidence) => recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: challenge.id,
      recipeHash: candidate.recipeHash, input: challenge.input, result: value });
    await expect(record(evidence)).rejects.toBeInstanceOf(DiscoveryConflictError);
    await expect(record({ ...evidence, slots: [{ ...evidence.slots[0], startsAt: "2030-01-02T23:00:00.000Z", endsAt: "2030-01-03T00:00:00.000Z" }] })).resolves.toEqual({ verifiedCount: 1 });
  });
});
