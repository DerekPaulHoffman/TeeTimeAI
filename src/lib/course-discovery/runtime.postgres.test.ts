// @vitest-environment node
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { executeAccessRecipe } from "./executor";
import { parseAccessRecipe, type AccessExecutionInput } from "./recipe";

let client: PrismaClient;
vi.mock("@/lib/prisma", () => ({ get prisma() { return client; } }));
vi.mock("./config", async original => ({ ...await original<object>(), isDiscoveryPilotSearch: () => true, isCourseDiscoveryEnabled: () => false,
  activeDiscoveryPilotSearchIds: async (_env: unknown, reader = client) => (await reader.teeSearch.findMany({ where: { userId: { in: ids.users } }, select: { id: true } })).map(search => search.id) }));
const mail = vi.hoisted(() => ({ match: vi.fn().mockResolvedValue({ deliveryStatus: "sent", id: "isolated-mail-sink" }), status: vi.fn().mockResolvedValue({ deliveryStatus: "sent", id: "isolated-mail-sink" }) }));
vi.mock("@/lib/email/alerts", async original => ({ ...await original<object>(), sendTeeTimeAlert: mail.match, sendSearchStatusEmail: mail.status, sendSimulatorStatusEmail: mail.status }));
const url = process.env.COURSE_DISCOVERY_TEST_DATABASE_URL;
const ids = { users: [] as string[], courses: [] as string[], runs: [] as string[] };
let service: typeof import("./service");
let runtime: typeof import("./runtime");

describe.skipIf(!url)("learned recipe through durable execution and normal matches", () => {
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) || parsed.pathname !== "/course_discovery_test") throw new Error("An isolated local test database is required");
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url!, connectionTimeoutMillis: 5000 }) });
    await client.$connect();
    service = await import("./service"); runtime = await import("./runtime");
    vi.stubEnv("SIMULATOR_MODE_ENABLED", "true");
  });
  afterEach(async () => {
    if (!client) return;
    await client.course.deleteMany({ where: { id: { in: ids.courses } } });
    await client.user.deleteMany({ where: { id: { in: ids.users } } });
    await client.automationRun.deleteMany({ where: { id: { in: ids.runs } } });
    ids.users.length = 0; ids.courses.length = 0; ids.runs.length = 0; mail.match.mockClear(); mail.status.mockClear();
  });
  afterAll(async () => { if (client) await client.$disconnect(); vi.unstubAllEnvs(); });

  async function fixture(simulator = false) {
    const suffix = randomUUID();
    const course = await client.course.create({ data: { name: `Fixture Golf ${suffix}`, latitude: 41, longitude: -73,
      isPublic: !simulator, timeZone: "UTC", website: "https://golf.example.com/", detectedBookingUrl: "https://golf.example.com/times", providerFamilyKey: "EXAMPLE" } });
    ids.courses.push(course.id);
    const offering = simulator ? await client.courseOffering.create({ data: { courseId: course.id, kind: "SIMULATOR", active: true,
      publicAccessStatus: "UNVERIFIED", bookingUrl: "https://golf.example.com/times", providerFamilyKey: "EXAMPLE" } }) : null;
    const user = await client.user.create({ data: { email: `${suffix}@example.test`, clerkUserId: suffix } }); ids.users.push(user.id);
    const date = new Date(); date.setUTCDate(date.getUTCDate() + 2); date.setUTCHours(0, 0, 0, 0);
    const token = randomUUID();
    const search = await client.teeSearch.create({ data: { userId: user.id, date, mode: simulator ? "SIMULATOR" : "OUTDOOR", durationMinutes: simulator ? 60 : null,
      startTime: "09:00", endTime: "17:00", players: 2, userTimeZone: "UTC", trafficClass: "PUBLIC", checkStatus: "CHECKING",
      checkLeaseToken: token, checkLeaseExpiresAt: new Date(Date.now() + 900_000), preferences: { create: { courseId: course.id, offeringId: offering?.id, rank: 1 } } } });
    const target = { courseId: course.id, ...(offering ? { offeringId: offering.id } : {}), kind: search.mode };
    const recipe = parseAccessRecipe({ schemaVersion: 1, engine: "HTTP_JSON", target,
      source: { officialUrl: course.website, bookingUrl: course.detectedBookingUrl, venueName: course.name, providerFamily: "EXAMPLE", timeZone: "UTC" },
      request: { url: simulator ? "https://golf.example.com/times?date={{date}}" : "https://golf.example.com/times?date={{date}}&players={{players}}", method: "GET" },
      permittedRoutes: [{ origin: "https://golf.example.com", path: "/times", methods: ["GET"], queryKeys: ["date", "players"] }],
      proof: { venue: { path: "venue" }, date: { path: "date" }, complete: { path: "complete" }, players: { path: "players" }, empty: { path: "empty" }, ...(simulator ? { durationMinutes: { path: "duration" } } : {}) },
      slots: { collection: { path: "slots" }, startsAt: { path: "start" }, availableSpots: { path: "spots" }, ...(simulator ? { endsAt: { path: "end" }, resourceId: { path: "resource" }, productId: { path: "product" } } : {}) } });
    const input = { date: date.toISOString().slice(0, 10), timeZone: "UTC", players: 2, startTime: "09:00", endTime: "17:00", ...(simulator ? { durationMinutes: 60 } : {}) };
    const run = async (parameters: AccessExecutionInput) => executeAccessRecipe(recipe, parameters, {
      fetch: vi.fn(async () => new Response(JSON.stringify({ venue: course.name, date: parameters.date, players: parameters.players, complete: true, empty: false, duration: 60,
        slots: [{ start: `${parameters.date}T10:00:00Z`, end: `${parameters.date}T11:00:00Z`, spots: 4, resource: "bay-1", product: "rental" }] }), { headers: { "content-type": "application/json" } })) as typeof fetch,
      requestLease: async (_family, work) => ({ acquired: true, value: await work() }),
    });
    await service.ensureDiscoveryJob({ ...target, searchId: search.id });
    const owner = (await service.claimNextDiscoveryJob(`worker-${suffix}`))!;
    const proposed = await service.proposeDiscoveryRecipe(owner.id, owner.leaseToken!, recipe);
    for (const challenge of proposed.challenges) await service.recordDiscoveryVerification({ jobId: owner.id, leaseToken: owner.leaseToken!, challengeId: challenge.id,
      recipeHash: proposed.recipeHash, input: challenge.input, result: await run(challenge.input) });
    const activated = await service.activateDiscoveryRecipe(owner.id, owner.leaseToken!);
    return { course, offering, search, target, input, run, activated, lease: { searchId: search.id, token, scheduleVersion: search.scheduleVersion, expiresAt: search.checkLeaseExpiresAt! } };
  }

  it("queues once, claims once and consumes a fresh no-model execution", async () => {
    const f = await fixture();
    expect(await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input })).toEqual({ state: "pending" });
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const first = (await runtime.claimNextRecipeExecution("reader-one"))!;
    expect(await runtime.claimNextRecipeExecution("reader-two")).toBeNull();
    const result = await f.run(first.input);
    await runtime.completeRecipeExecution(first.id, first.leaseToken, result);
    await runtime.completeRecipeExecution(first.id, first.leaseToken, result);
    expect(await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input })).toMatchObject({ state: "ready", result: { status: "AVAILABLE" } });
    expect(await client.localReaderJob.count({ where: { courseId: f.course.id, purpose: "RECIPE_CHECK" } })).toBe(1);
  });

  it.each([-2100, 2100])("retains a fresh reader timestamp with %ims skew", async offset => {
    const f = await fixture();
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const claim = (await runtime.claimNextRecipeExecution("skew-reader"))!;
    const stored = await client.localReaderJob.findUniqueOrThrow({ where: { id: claim.id } });
    const result = { ...await f.run(claim.input), observedAt: new Date(stored.claimedAt!.getTime() + offset).toISOString() };
    await runtime.completeRecipeExecution(claim.id, claim.leaseToken, result);
    expect((await client.localReaderJob.findUniqueOrThrow({ where: { id: claim.id } })).result).toMatchObject({ observedAt: result.observedAt });
  });

  it("rejects stale, future, superseded and expired warm proofs without accepting an old result", async () => {
    const f = await fixture();
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const claim = (await runtime.claimNextRecipeExecution("skew-reader"))!;
    const stored = await client.localReaderJob.findUniqueOrThrow({ where: { id: claim.id } });
    const result = await f.run(claim.input);
    for (const observedAt of [new Date(stored.claimedAt!.getTime() - 5001), new Date(Date.now() + 60000)])
      await expect(runtime.completeRecipeExecution(claim.id, claim.leaseToken, { ...result, observedAt: observedAt.toISOString() })).rejects.toThrow("no longer current");
    await client.teeSearch.update({ where: { id: f.search.id }, data: { alertGeneration: { increment: 1 } } });
    await expect(runtime.completeRecipeExecution(claim.id, claim.leaseToken, result)).rejects.toThrow("no longer current");
    await client.teeSearch.update({ where: { id: f.search.id }, data: { alertGeneration: f.search.alertGeneration } });
    await client.localReaderJob.update({ where: { id: claim.id }, data: { jobExpiresAt: new Date(Date.now() - 1) } });
    await expect(runtime.completeRecipeExecution(claim.id, claim.leaseToken, result)).rejects.toThrow("lease expired");
    expect((await client.localReaderJob.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe("LEASED");
  });

  it("recovers the first-warm deadline from Postgres, then gives later checks a normal budget", async () => {
    const f = await fixture();
    const deadline = new Date(Date.now() + 120_000);
    await client.courseDiscoveryJob.update({ where: { id: f.activated.jobId }, data: { firstPickedUpAt: new Date(deadline.getTime() - 900_000), deadlineAt: deadline } });
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const first = (await runtime.claimNextRecipeExecution("restarted-first-reader"))!;
    expect(first.deadlineAt).toBe(deadline.toISOString());
    expect(first.coldStart).toMatchObject({ discoveryJobId: f.activated.jobId, initialExecution: true, deadlineAt: deadline.toISOString() });
    await client.localReaderJob.update({ where: { id: first.id }, data: { jobExpiresAt: new Date(0), status: "EXPIRED" } });
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const second = (await runtime.claimNextRecipeExecution("restarted-later-reader"))!;
    expect(Date.parse(second.deadlineAt)).toBeGreaterThan(Date.now() + 175_000);
    expect(second.coldStart).toMatchObject({ initialExecution: false, deadlineAt: deadline.toISOString() });
    expect((await service.getActiveAccessRecipe(f.target))?.record.id).toBe(f.activated.recipeId);
  });

  it("repairs a queued resume version only while the original demand is unchanged", async () => {
    const f = await fixture();
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const execution = (await runtime.claimNextRecipeExecution("reader-one"))!;
    await runtime.completeRecipeExecution(execution.id, execution.leaseToken, await f.run(execution.input));
    await client.teeSearch.update({ where: { id: f.search.id }, data: { scheduleVersion: { increment: 1 }, checkStatus: "QUEUED" } });
    expect(await runtime.attachRecipeResumeVersion(execution.id, f.search.scheduleVersion + 1, f.search.id)).toBe(true);
    expect(await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input })).toMatchObject({ state: "ready" });
    await client.teeSearch.update({ where: { id: f.search.id }, data: { players: 3, scheduleVersion: { increment: 1 } } });
    expect(await runtime.attachRecipeResumeVersion(execution.id, f.search.scheduleVersion + 2, f.search.id)).toBe(false);
  });

  it.each(["pause", "edit", "source"])("rejects an in-flight result after %s changes", async change => {
    const f = await fixture();
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const job = (await runtime.claimNextRecipeExecution("reader-one"))!;
    const result = await f.run(job.input);
    if (change === "source") await client.course.update({ where: { id: f.course.id }, data: { website: "https://new.example.com/" } });
    else await client.teeSearch.update({ where: { id: f.search.id }, data: change === "pause" ? { status: "PAUSED" } : { scheduleVersion: { increment: 1 }, players: 3 } });
    await expect(runtime.completeRecipeExecution(job.id, job.leaseToken, result)).rejects.toThrow();
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: f.search.id } })).toBe(0);
  });

  it.each([false, true])("reaches the normal match and email sink path (simulator=%s)", async simulator => {
    const f = await fixture(simulator);
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const job = (await runtime.claimNextRecipeExecution("reader-one"))!;
    await runtime.completeRecipeExecution(job.id, job.leaseToken, await f.run(job.input));
    const { runSearchCheck } = await import("@/lib/automation/search-check");
    const outcome = await runSearchCheck(f.search.id, "isolated-recipe-test", f.lease);
    ids.runs.push(...(await client.automationRun.findMany({ where: { notes: { contains: "isolated-recipe-test" } }, select: { id: true } })).map(run => run.id));
    expect(outcome.courseResults[0]).toMatchObject({ outcome: "MATCH_FOUND", availableMatches: 1 });
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: f.search.id, availabilityStatus: "AVAILABLE" } })).toBe(1);
    expect(mail.match.mock.calls.length + mail.status.mock.calls.length).toBe(1);
    const delivered = await client.searchEmailDelivery.findMany({ where: { teeSearchId: f.search.id, status: "SENT" }, select: { payload: true } });
    expect(JSON.stringify(delivered)).toContain("matchIds");
    expect(await client.searchEmailDelivery.count({ where: { teeSearchId: f.search.id } })).toBeGreaterThan(0);
    expect((await client.localReaderJob.findUniqueOrThrow({ where: { id: job.id } })).sourceContext).toMatchObject({
      consumed: { recipeHash: expect.any(String), observedAt: expect.any(String), consumedAt: expect.any(String) },
    });
  });

  it.each([[false, "EMPTY"], [false, "FAILED"], [true, "EMPTY"], [true, "FAILED"]] as const)(
    "defers an actual outbox retry until a newer recipe result is consumed (simulator=%s, result=%s)", async (simulator, status) => {
      const f = await fixture(simulator);
      const { runSearchCheck } = await import("@/lib/automation/search-check");
      const { drainSearchEmailDeliveryGroup } = await import("@/lib/email/search-delivery-outbox");
      await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
      const first = (await runtime.claimNextRecipeExecution("first-reader"))!;
      const available = await f.run(first.input);
      await runtime.completeRecipeExecution(first.id, first.leaseToken, available);
      mail.match.mockRejectedValue(new Error("Isolated mail transport unavailable"));
      mail.status.mockRejectedValue(new Error("Isolated mail transport unavailable"));
      try { await runSearchCheck(f.search.id, "isolated-outbox-retry", f.lease); } catch { /* A durable retry is expected. */ }
      const before = await client.teeTimeMatch.findMany({ where: { teeSearchId: f.search.id, availabilityStatus: "AVAILABLE" } });
      expect(before).toHaveLength(1);
      const groups = (await client.searchEmailDelivery.findMany({ where: { teeSearchId: f.search.id, status: "FAILED" } }))
        .filter(row => Array.isArray((row.payload as { matchIds?: unknown }).matchIds) && (row.payload as { matchIds: unknown[] }).matchIds.length > 0);
      expect(groups.length).toBeGreaterThan(0);
      await client.localReaderJob.update({ where: { id: first.id }, data: { resultExpiresAt: new Date(0) } });
      await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
      const next = (await runtime.claimNextRecipeExecution("next-reader"))!;
      await runtime.completeRecipeExecution(next.id, next.leaseToken, { ...available, observedAt: new Date().toISOString(),
        status, complete: status === "EMPTY", slots: [] });
      await client.searchEmailDelivery.updateMany({ where: { teeSearchId: f.search.id, status: "FAILED" }, data: { nextAttemptAt: new Date(0) } });
      mail.match.mockResolvedValue({ deliveryStatus: "sent", id: "isolated-mail-sink" });
      mail.status.mockResolvedValue({ deliveryStatus: "sent", id: "isolated-mail-sink" });
      const transport = vi.fn().mockResolvedValue({ deliveryStatus: "sent" as const });
      const group = groups[0];
      await expect(drainSearchEmailDeliveryGroup({ searchId: f.search.id, alertGeneration: f.search.alertGeneration,
        checkLeaseToken: f.lease.token, kind: group.kind, groupKey: group.groupKey, send: transport })).rejects.toThrow("newer provider observation");
      expect(transport).not.toHaveBeenCalled();
      // An unconsumed read must gate transport without rewriting prior match truth.
      expect((await client.teeTimeMatch.findUniqueOrThrow({ where: { id: before[0].id } })).availabilityStatus).toBe("AVAILABLE");
      expect(await client.searchEmailDelivery.count({ where: { teeSearchId: f.search.id, status: "SENT" } })).toBe(0);
    });

  it.each([false, true])("suppresses an unsent outbox group after a newer EMPTY is canonically consumed (simulator=%s)", async simulator => {
    const f = await fixture(simulator);
    const { runSearchCheck } = await import("@/lib/automation/search-check");
    const { drainSearchEmailDeliveryGroup } = await import("@/lib/email/search-delivery-outbox");
    const runTag = `isolated-vanished-unsent-${f.search.id}`;
    try {
      await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
      const first = (await runtime.claimNextRecipeExecution("unsent-first-reader"))!;
      const available = await f.run(first.input);
      await runtime.completeRecipeExecution(first.id, first.leaseToken, available);
      mail.match.mockRejectedValue(new Error("Isolated mail transport unavailable"));
      mail.status.mockRejectedValue(new Error("Isolated mail transport unavailable"));
      try { await runSearchCheck(f.search.id, runTag, f.lease); } catch { /* Retain the durable unsent obligation. */ }
      const match = await client.teeTimeMatch.findFirstOrThrow({ where: { teeSearchId: f.search.id, availabilityStatus: "AVAILABLE" } });
      expect(match.alertStatus).not.toBe("SENT");
      expect(match.sentAt).toBeNull();
      const groups = (await client.searchEmailDelivery.findMany({ where: { teeSearchId: f.search.id, status: "FAILED" } }))
        .filter(row => Array.isArray((row.payload as { matchIds?: unknown }).matchIds) &&
          (row.payload as { matchIds: unknown[] }).matchIds.includes(match.id));
      expect(groups.length).toBeGreaterThan(0);
      expect(groups.every(row => row.attemptCount > 0 && row.sentAt === null)).toBe(true);

      await client.localReaderJob.update({ where: { id: first.id }, data: { resultExpiresAt: new Date(0) } });
      await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
      const next = (await runtime.claimNextRecipeExecution("unsent-next-reader"))!;
      const empty = { ...available, observedAt: new Date().toISOString(), status: "EMPTY" as const, slots: [] };
      await runtime.completeRecipeExecution(next.id, next.leaseToken, empty);
      await client.searchEmailDelivery.updateMany({ where: { id: { in: groups.map(row => row.id) } }, data: { nextAttemptAt: new Date(0) } });
      mail.match.mockResolvedValue({ deliveryStatus: "sent", id: "isolated-mail-sink" });
      mail.status.mockResolvedValue({ deliveryStatus: "sent", id: "isolated-mail-sink" });
      const outcome = await runSearchCheck(f.search.id, runTag, f.lease);
      expect(outcome.courseResults[0].outcome).toBe("NO_MATCH");
      expect((await client.localReaderJob.findUniqueOrThrow({ where: { id: next.id } })).sourceContext).toMatchObject({
        consumed: { recipeHash: empty.evidence.recipeHash, observedAt: empty.observedAt, consumedAt: expect.any(String) },
      });
      expect(await client.teeTimeMatch.findUniqueOrThrow({ where: { id: match.id } })).toMatchObject({ availabilityStatus: "GONE", sentAt: null });

      const transport = vi.fn().mockResolvedValue({ deliveryStatus: "sent" as const });
      for (const group of groups) {
        await expect(drainSearchEmailDeliveryGroup({ searchId: f.search.id, alertGeneration: f.search.alertGeneration,
          checkLeaseToken: f.lease.token, kind: group.kind, groupKey: group.groupKey, send: transport }))
          .resolves.toContainEqual({ id: group.id, status: "SUPPRESSED" });
        const suppressed = await client.searchEmailDelivery.findUniqueOrThrow({ where: { id: group.id } });
        expect(suppressed).toMatchObject({ status: "SUPPRESSED", sentAt: null });
        expect(suppressed.payload).toEqual(group.payload);
      }
      expect(transport).not.toHaveBeenCalled();
      expect(await client.searchEmailDelivery.count({ where: { id: { in: groups.map(row => row.id) }, status: "SENT" } })).toBe(0);
    } finally {
      mail.match.mockResolvedValue({ deliveryStatus: "sent", id: "isolated-mail-sink" });
      mail.status.mockResolvedValue({ deliveryStatus: "sent", id: "isolated-mail-sink" });
      ids.runs.push(...(await client.automationRun.findMany({ where: { notes: { contains: runTag } }, select: { id: true } })).map(run => run.id));
    }
  });

  it.each([false, true])("preserves a sent legacy opening when repaired by a generic recipe (simulator=%s)", async simulator => {
    const f = await fixture(simulator);
    await client.teeSearch.update({ where: { id: f.search.id }, data: { statusEmailSentAt: new Date() } });
    const start = new Date(`${f.input.date}T10:00:00Z`);
    const legacy = await client.teeTimeMatch.create({ data: { teeSearchId: f.search.id, courseId: f.course.id,
      offeringId: f.offering?.id, sourceId: "legacy-source-id", startsAt: start,
      ...(simulator ? { endsAt: new Date(`${f.input.date}T11:00:00Z`), resourceId: "bay-1", productId: "rental" } : {}),
      availableSpots: simulator ? 1 : 4, bookingUrl: "https://golf.example.com/times",
      alertStatus: "SENT", sentAt: new Date(), availabilityStatus: "AVAILABLE",
    } });
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const job = (await runtime.claimNextRecipeExecution("repair-reader"))!;
    await runtime.completeRecipeExecution(job.id, job.leaseToken, await f.run(job.input));
    const { runSearchCheck } = await import("@/lib/automation/search-check");
    const result = await runSearchCheck(f.search.id, "isolated-recipe-identity", f.lease);
    ids.runs.push(...(await client.automationRun.findMany({ where: { notes: { contains: "isolated-recipe-identity" } }, select: { id: true } })).map(run => run.id));
    expect(result.courseResults[0].outcome).toBe("MATCH_FOUND");
    expect(await client.teeTimeMatch.findMany({ where: { teeSearchId: f.search.id }, select: { id: true, sourceId: true, alertStatus: true, availabilityStatus: true } }))
      .toEqual([{ id: legacy.id, sourceId: "legacy-source-id", alertStatus: "SENT", availabilityStatus: "AVAILABLE" }]);
    expect(await client.searchEmailDelivery.count({ where: { teeSearchId: f.search.id, kind: "MATCH" } })).toBe(0);
    expect(mail.match).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports an exhausted repair without opening another job (simulator=%s)", async simulator => {
    const f = await fixture(simulator);
    await service.degradeRecipe(f.target, f.activated.recipeId);
    await service.ensureDiscoveryJob({ ...f.target, searchId: f.search.id });
    const repair = (await service.claimNextDiscoveryJob("repair-worker"))!;
    await service.failDiscoveryJob(repair.id, repair.leaseToken!, "TOOL_FAILURE", true);
    const retry = (await service.claimNextDiscoveryJob("repair-worker"))!;
    await service.failDiscoveryJob(retry.id, retry.leaseToken!, "TOOL_FAILURE", true);
    const { runSearchCheck } = await import("@/lib/automation/search-check");
    for (let check = 0; check < 2; check++) {
      const outcome = await runSearchCheck(f.search.id, "isolated-recipe-terminal", f.lease);
      expect(outcome.courseResults[0].outcome).toBe("FETCH_FAILED");
    }
    expect(await client.courseDiscoveryJob.count({ where: { courseId: f.course.id } })).toBe(2);
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: f.search.id } })).toBe(0);
  });

  it.each(["BROWSER_UNAVAILABLE", "PROVIDER_THROTTLED", "PIPELINE_DEADLINE"])("retains the proven recipe for retryable failure %s", async reason => {
    const f = await fixture();
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const job = (await runtime.claimNextRecipeExecution("reader-one"))!;
    const available = await f.run(job.input);
    const unavailable = { ...available, status: "FAILED", complete: false, slots: [],
      evidence: { ...available.evidence, reason } };
    await runtime.completeRecipeExecution(job.id, job.leaseToken, unavailable);
    expect(runtime.recipeExecutionNeedsRepair(unavailable as typeof available)).toBe(false);
    const { getLearnedAvailability } = await import("./checks");
    const { getActiveSearchForAutomation } = await import("@/lib/automation/db-service");
    const search = (await getActiveSearchForAutomation(f.search.id))!;
    expect(await getLearnedAvailability(search, search.preferences[0])).toMatchObject({ state: "failed", outcome: reason });
    expect((await service.getActiveAccessRecipe(f.target))?.record.id).toBe(f.activated.recipeId);
    expect(await client.courseDiscoveryJob.count({ where: { courseId: f.course.id } })).toBe(1);
    const { runSearchCheck } = await import("@/lib/automation/search-check");
    const outcome = await runSearchCheck(f.search.id, "isolated-reader-unavailable", f.lease);
    expect(outcome.courseResults[0].outcome).toBe("CHECK_PENDING");
    expect(outcome.supportRetryAt!.getTime()).toBeLessThanOrEqual(Date.now() + 65_000);
  });

  it("still delivers another simulator when one recipe observation becomes stale", async () => {
    const first = await fixture(true);
    const second = await fixture(true);
    await client.coursePreference.create({ data: { teeSearchId: first.search.id, courseId: second.course.id, offeringId: second.offering!.id, rank: 2 } });
    for (const f of [first, second]) {
      await runtime.getOrQueueRecipeExecution({ searchId: first.search.id, target: f.target, input: first.input });
      const execution = (await runtime.claimNextRecipeExecution("reader-one"))!;
      await runtime.completeRecipeExecution(execution.id, execution.leaseToken, await f.run(execution.input));
    }
    const proof = vi.spyOn(runtime, "assertRecipeObservationCurrent").mockRejectedValueOnce(new Error("source changed during commit"));
    try {
      const { runSearchCheck } = await import("@/lib/automation/search-check");
      const outcome = await runSearchCheck(first.search.id, "isolated-recipe-partial", first.lease);
      expect(outcome.courseResults.map(result => result.outcome)).toEqual(["FETCH_FAILED", "MATCH_FOUND"]);
      expect(await client.teeTimeMatch.count({ where: { teeSearchId: first.search.id, availabilityStatus: "AVAILABLE" } })).toBe(1);
      expect(mail.match.mock.calls.length + mail.status.mock.calls.length).toBeGreaterThan(0);
    } finally { proof.mockRestore(); }
  });

  it("keeps checking and delivering other simulators when failed-method admission throws", async () => {
    const first = await fixture(true);
    const second = await fixture(true);
    await client.coursePreference.create({ data: { teeSearchId: first.search.id, courseId: second.course.id, offeringId: second.offering!.id, rank: 2 } });
    const checks = await import("./checks");
    const providers = await import("@/lib/simulators/providers");
    const learned = vi.spyOn(checks, "getLearnedAvailability").mockResolvedValue(null);
    const admission = vi.spyOn(checks, "queueFailedSimulatorDiscovery").mockRejectedValue(new Error("Admission unavailable"));
    const fetch = vi.spyOn(providers, "fetchSimulatorAvailability")
      .mockRejectedValueOnce(new Error("Provider schema changed"))
      .mockImplementationOnce(async () => ({ complete: true, observedAt: new Date(), evidenceUrl: "https://golf.example.com/times",
        slots: [{ sourceId: "native-slot", offeringId: second.offering!.id, resourceId: "bay-1", productId: "rental",
          startsAt: new Date(`${first.input.date}T10:00:00Z`), endsAt: new Date(`${first.input.date}T11:00:00Z`),
          maxPartySize: null, bookingUrl: "https://golf.example.com/times" }] }));
    try {
      const { runSearchCheck } = await import("@/lib/automation/search-check");
      const result = await runSearchCheck(first.search.id, "isolated-admission-failure", first.lease);
      expect(result.courseResults.map(course => course.outcome)).toEqual(["FETCH_FAILED", "MATCH_FOUND"]);
      expect(admission).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(await client.teeTimeMatch.count({ where: { teeSearchId: first.search.id, offeringId: second.offering!.id, availabilityStatus: "AVAILABLE" } })).toBe(1);
      expect(mail.match.mock.calls.length + mail.status.mock.calls.length).toBeGreaterThan(0);
    } finally { fetch.mockRestore(); admission.mockRestore(); learned.mockRestore(); }
  });

  it("keeps a previously emailed opening visible while its next recipe read is pending", async () => {
    const f = await fixture();
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const job = (await runtime.claimNextRecipeExecution("first-reader"))!;
    await runtime.completeRecipeExecution(job.id, job.leaseToken, await f.run(job.input));
    const { runSearchCheck } = await import("@/lib/automation/search-check");
    await runSearchCheck(f.search.id, "isolated-pending-visibility", f.lease);
    const before = await client.teeTimeMatch.findFirstOrThrow({ where: { teeSearchId: f.search.id } });
    expect(before.alertStatus).toBe("SENT");
    await client.localReaderJob.update({ where: { id: job.id }, data: { resultExpiresAt: new Date(0) } });
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const result = await runSearchCheck(f.search.id, "isolated-pending-visibility", f.lease);
    expect(result.courseResults[0].outcome).toBe("CHECK_PENDING");
    expect(await client.teeTimeMatch.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ alertStatus: "SENT", availabilityStatus: "AVAILABLE" });
    expect(mail.match.mock.calls.length + mail.status.mock.calls.length).toBe(1);
  });

  it.each([false, true])("removes vanished slots without duplicate match delivery (simulator=%s)", async simulator => {
    const f = await fixture(simulator);
    const { runSearchCheck } = await import("@/lib/automation/search-check");
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const first = (await runtime.claimNextRecipeExecution("reader-one"))!;
    const available = await f.run(first.input);
    await runtime.completeRecipeExecution(first.id, first.leaseToken, available);
    await runSearchCheck(f.search.id, "isolated-recipe-vanished", f.lease);
    expect(await client.searchEmailDelivery.count({ where: { teeSearchId: f.search.id, kind: "MATCH", status: "SENT" } })).toBeLessThanOrEqual(1);
    await client.localReaderJob.update({ where: { id: first.id }, data: { resultExpiresAt: new Date(0) } });
    await runtime.getOrQueueRecipeExecution({ searchId: f.search.id, target: f.target, input: f.input });
    const next = (await runtime.claimNextRecipeExecution("restarted-reader"))!;
    await runtime.completeRecipeExecution(next.id, next.leaseToken, { ...available, observedAt: new Date().toISOString(), status: "EMPTY", slots: [] });
    const outcome = await runSearchCheck(f.search.id, "isolated-recipe-vanished", f.lease);
    expect(outcome.courseResults[0].outcome).toBe("NO_MATCH");
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: f.search.id, availabilityStatus: "AVAILABLE" } })).toBe(0);
    expect(await client.teeTimeMatch.count({ where: { teeSearchId: f.search.id, availabilityStatus: "GONE" } })).toBe(1);
    expect(mail.match.mock.calls.length + mail.status.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
