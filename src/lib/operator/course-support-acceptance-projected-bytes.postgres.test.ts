// @vitest-environment node

import { randomUUID } from "node:crypto";
import { CourseSupportBatchIncidentResult, CourseSupportBatchStatus, Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AcceptanceBytePreflightFence, createAcceptanceBytePreflight } from "./course-support-acceptance-read-size-boundary";

const EVIDENCE_BYTES = 16 * 1_024 * 1_024;
const LOCAL_DATABASE = "teetime_acceptance_projection";
const LOCAL_PORT = "54329";

function guardedLocalUrl(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  try {
    const url = new URL(value);
    if (!["postgresql:", "postgres:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1"].includes(url.hostname) || url.port !== LOCAL_PORT ||
        url.pathname !== `/${LOCAL_DATABASE}` || url.search || url.hash) throw new Error();
    return value;
  } catch {
    throw new Error("Explicit dedicated local PostgreSQL test target required.");
  }
}

// This file deliberately never imports the application's database/env loader.
const localUrl = guardedLocalUrl(process.env.COURSE_ACCEPTANCE_LOCAL_PG_URL);
type Query = Record<string, unknown>;
type NativeDelegate = { findMany: (query: Query) => Promise<unknown> };
type Fixture = {
  courseIds: [string, string]; searchId: string; probeId: string;
  discoveryId: string; runId: string; batchId: string;
};

describe("explicit local PostgreSQL acceptance proof target", () => {
  it("rejects remote, alternate-database, alternate-port and URL override targets before connecting", () => {
    for (const value of [
      "postgresql://postgres@example.invalid:54329/teetime_acceptance_projection",
      "postgresql://postgres@127.0.0.1:54329/postgres",
      "postgresql://postgres@127.0.0.1:5432/teetime_acceptance_projection",
      "postgresql://postgres@127.0.0.1:54329/teetime_acceptance_projection?host=example.invalid",
    ]) expect(() => guardedLocalUrl(value)).toThrow(/^Explicit dedicated local PostgreSQL test target required\.$/);
    expect(guardedLocalUrl(undefined)).toBeNull();
  });
});

describe.skipIf(localUrl === null)("native PostgreSQL selected-evidence byte upper bound", () => {
  let client: PrismaClient | undefined;

  beforeAll(async () => {
    // Guard precedes client construction and every fixture write. No DDL is run.
    const connectionString = guardedLocalUrl(localUrl ?? undefined)!;
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000 }), log: [] });
    const rows = await client.$queryRaw<Array<{ version: string; database: string }>>`
      SELECT version() AS version, current_database() AS database
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].database).toBe(LOCAL_DATABASE);
    expect(rows[0].version).toMatch(/^PostgreSQL 17\./);
    console.info(`LOCAL_ACCEPTANCE_POSTGRES_VERSION=${rows[0].version.match(/^PostgreSQL \d+\.\d+/u)![0]}`);
  });

  afterAll(async () => { await client?.$disconnect(); });

  async function withFixture(action: (transaction: Prisma.TransactionClient, fixture: Fixture) => Promise<void>) {
    const rollback = new Error("ROLLBACK_LOCAL_ACCEPTANCE_FIXTURE");
    try {
      await client!.$transaction(async (transaction) => {
        const key = `local-byte-proof-${randomUUID()}`;
        const fixture: Fixture = { courseIds: [`${key}-a`, `${key}-b`], searchId: `${key}-search`,
          probeId: `${key}-probe`, discoveryId: `${key}-discovery`, runId: `${key}-run`, batchId: `${key}-batch` };
        await transaction.user.create({ data: { id: `${key}-user`, clerkUserId: `${key}-clerk`,
          email: "local-proof@example.invalid" }, select: { id: true } });
        await transaction.course.createMany({ data: fixture.courseIds.map((id) => ({ id,
          name: "Local PostgreSQL byte proof", latitude: 41, longitude: -73,
          bookingMetadata: { escaped: '"\\\n\r\t\b\f\u001f\u2028\u2029', unicode: "é漢字⛳😀" },
          layoutHoleCounts: [9, 18],
        })) });
        await transaction.teeSearch.create({ data: { id: fixture.searchId, userId: `${key}-user`,
          date: new Date("2026-10-01T00:00:00.000Z"), startTime: "10:00", endTime: "14:00", players: 2,
          additionalEmails: ["local-extra@example.invalid"], statusEmailSnapshot: { message: "Local synthetic evidence" },
        }, select: { id: true } });
        await transaction.coursePreference.createMany({ data: fixture.courseIds.map((courseId, index) => ({
          id: `${key}-preference-${index}`, courseId, teeSearchId: fixture.searchId, rank: index + 1,
        })) });
        await transaction.courseMonitoringStatus.create({ data: { courseId: fixture.courseIds[0],
          reference: `${key}-monitor`, state: "ENGINEERING_VERIFICATION_NEEDED" }, select: { courseId: true } });
        await transaction.automationRun.create({ data: { id: fixture.runId, promptVersion: "local-byte-proof",
          notes: "Local notes", audit: { local: true }, runtimeVersion: "a".repeat(40),
        }, select: { id: true } });
        await transaction.courseProbe.create({ data: { id: fixture.probeId, courseId: fixture.courseIds[0],
          teeSearchId: fixture.searchId, automationRunId: fixture.runId, outcome: "NO_MATCH",
          observedAt: new Date("2026-09-30T00:00:00.123Z"), rawSummary: { local: "é漢字😀\n\\\"" },
        }, select: { id: true } });
        await transaction.courseAutomationDiscovery.create({ data: { id: fixture.discoveryId,
          courseId: fixture.courseIds[0], status: "LOCAL_PROOF", sourceUrl: "https://example.invalid/local-proof",
          apiMetadata: { local: true }, evidence: { local: true },
        }, select: { id: true } });
        await transaction.courseSupportBatch.create({ data: { id: fixture.batchId, reference: `${key}-batch-ref`,
          providerFamilyKey: "LOCAL_PROOF", failureFingerprint: "LOCAL_PROOF", ownerAutomationRunId: fixture.runId,
          leaseToken: "local-only", leaseExpiresAt: new Date("2026-10-01T00:00:00.000Z"),
          heartbeatAt: new Date("2026-09-30T00:00:00.000Z"), baseSha: "a".repeat(40), summary: { local: true },
        }, select: { id: true } });
        for (const [index, courseId] of fixture.courseIds.entries()) {
          const incidentId = `${key}-incident-${index}`;
          await transaction.courseSupportIncident.create({ data: { id: incidentId, reference: `${key}-incident-ref-${index}`,
            courseId, kind: "NEEDS_ADAPTER", courseNameSnapshot: "Local byte proof", platformSnapshot: "UNKNOWN",
          }, select: { id: true } });
          await transaction.courseSupportBatchIncident.create({ data: { id: `${key}-entry-${index}`,
            batchId: fixture.batchId, incidentId, courseId, cycle: 1, proofSnapshot: { local: true },
          }, select: { id: true } });
        }
        await action(transaction, fixture);
        throw rollback;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 30_000 });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }

  function preflight(transaction: Prisma.TransactionClient, maxBytes = EVIDENCE_BYTES) {
    return createAcceptanceBytePreflight(transaction, { tick: () => {}, maxBytes });
  }

  async function assertNativeBound(transaction: Prisma.TransactionClient, model: string, query: Query) {
    const delegate = Reflect.get(transaction, model) as NativeDelegate;
    const native = await delegate.findMany(query);
    const nativeBytes = Buffer.byteLength(JSON.stringify(native), "utf8");
    expect(nativeBytes).toBeGreaterThan(0);
    await expect(preflight(transaction, nativeBytes - 1)(model, "findMany", query)).rejects.toMatchObject({
      reason: "EVIDENCE_BOUND_EXCEEDED",
    });
    await preflight(transaction)(model, "findMany", query);
    expect(await delegate.findMany(query)).toEqual(native);
    return nativeBytes;
  }

  async function minimumAllowance(transaction: Prisma.TransactionClient, model: string, query: Query, nativeBytes: number) {
    let low = nativeBytes - 1;
    let high = EVIDENCE_BYTES;
    await expect(preflight(transaction, low)(model, "findMany", query)).rejects.toMatchObject({
      reason: "EVIDENCE_BOUND_EXCEEDED",
    });
    await preflight(transaction, high)(model, "findMany", query);
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      try { await preflight(transaction, middle)(model, "findMany", query); high = middle; }
      catch (error) {
        if (!(error instanceof AcceptanceBytePreflightFence) || error.reason !== "EVIDENCE_BOUND_EXCEEDED") throw error;
        low = middle;
      }
    }
    return high;
  }

  it("ignores huge unselected probe/discovery/run columns but rejects selected JSON before native hydration", async () => {
    await withFixture(async (transaction, fixture) => {
      const huge = { text: "x".repeat(EVIDENCE_BYTES + 1_024) };
      await transaction.courseProbe.updateMany({ where: { id: fixture.probeId }, data: { rawSummary: huge } });
      await transaction.courseAutomationDiscovery.updateMany({ where: { id: fixture.discoveryId },
        data: { evidence: huge } });
      await transaction.automationRun.updateMany({ where: { id: fixture.runId }, data: { audit: huge } });
      for (const [model, id, select] of [
        ["courseProbe", fixture.probeId, { id: true, courseId: true, observedAt: true }],
        ["courseAutomationDiscovery", fixture.discoveryId, { id: true, courseId: true, createdAt: true }],
        ["automationRun", fixture.runId, { id: true, status: true, runtimeVersion: true, notes: true }],
      ] as const) await assertNativeBound(transaction, model, { where: { id }, orderBy: { id: "asc" }, select });

      for (const query of [
        { where: { id: fixture.probeId }, select: { rawSummary: true } },
        { where: { id: fixture.probeId }, select: null },
        { where: { id: fixture.probeId }, include: null },
      ]) {
        let nativeHydrated = false;
        await expect((async () => {
          await preflight(transaction)("courseProbe", "findMany", query);
          nativeHydrated = true;
          return transaction.courseProbe.findMany(query);
        })()).rejects.toMatchObject({ reason: "EVIDENCE_BOUND_EXCEEDED" });
        expect(nativeHydrated).toBe(false);
      }
    });
  }, 40_000);

  it("bounds full/default/include and explicit false selections using real generated Prisma results", async () => {
    await withFixture(async (transaction, fixture) => {
      const where = { id: fixture.courseIds[0] };
      for (const query of [
        { where },
        { where, select: null },
        { where, include: null },
        { where, include: { monitoringStatus: true, probes: false } },
        { where, select: { id: true, name: true, bookingMetadata: false, probes: false } },
        { where, include: { preferences: { select: { rank: true, teeSearch: { select: {
          date: true, players: true, additionalEmails: true, statusEmailSnapshot: true,
        } } } } } },
      ]) await assertNativeBound(transaction, "course", query);
    });
  });

  it("covers relation nulls, empty lists, omitted IDs and filtered native count fields", async () => {
    await withFixture(async (transaction, fixture) => {
      await assertNativeBound(transaction, "course", { where: { id: { in: fixture.courseIds } }, orderBy: { id: "asc" },
        select: { id: false, monitoringStatus: { select: { state: true } },
          probes: { select: { id: false, outcome: true } },
          _count: { select: { probes: true, preferences: true } },
        } });
      await assertNativeBound(transaction, "courseSupportBatch", { where: { id: fixture.batchId },
        select: { _count: true, ownerAutomationRun: { select: { notes: true } } } });
    });
  });

  it("bounds Unicode, JSON escaping, extreme finite numbers, millisecond dates and integer lists", async () => {
    await withFixture(async (transaction, fixture) => {
      await transaction.course.updateMany({ where: { id: fixture.courseIds[0] }, data: {
        name: "é漢字⛳😀\n\\\"".repeat(100), latitude: 1e308, longitude: 1e-300,
        rating: -1e308, bookingWindowConfidence: 1e-30,
        createdAt: new Date("0001-01-01T00:00:00.000Z"), intelligenceVerifiedAt: new Date("9999-12-31T23:59:59.999Z"),
        layoutHoleCounts: [-2_147_483_648, 0, 9, 18, 2_147_483_647],
        bookingMetadata: { 'quote"\\\n': [null, true, false, Number.MAX_VALUE, Number.MIN_VALUE,
          { unicode: "é漢字⛳😀\u2028\u2029".repeat(100), escaped: '"\\\n\r\t\b\f\u001f' }],
        },
      } });
      await assertNativeBound(transaction, "course", { where: { id: fixture.courseIds[0] } });
      await assertNativeBound(transaction, "course", { where: { id: fixture.courseIds[0] }, select: {
        id: false, latitude: true, longitude: true, rating: true, createdAt: true, intelligenceVerifiedAt: true,
        layoutHoleCounts: true, bookingMetadata: true, detectedPlatform: true,
      } });
    });
  });

  it("charges shared identities reached through different projections and repeated reads cumulatively", async () => {
    await withFixture(async (transaction, fixture) => {
      const query = { where: { id: { in: fixture.courseIds } }, orderBy: { id: "asc" }, select: {
        probes: { select: { observedAt: true, rawSummary: false } },
        preferences: { select: { teeSearch: { select: { probes: { select: { rawSummary: true } } } } } },
      } };
      const nativeBytes = await assertNativeBound(transaction, "course", query);
      let low = nativeBytes - 1;
      let high = EVIDENCE_BYTES;
      // Fresh instances isolate each measurement; no public observability seam.
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        try { await preflight(transaction, middle)("course", "findMany", query); high = middle; }
        catch (error) {
          if (!(error instanceof AcceptanceBytePreflightFence) || error.reason !== "EVIDENCE_BOUND_EXCEEDED") throw error;
          low = middle;
        }
      }
      expect(high).toBeGreaterThanOrEqual(nativeBytes);
      const cumulative = preflight(transaction, high);
      await cumulative("course", "findMany", query);
      await expect(cumulative("course", "findMany", query)).rejects.toMatchObject({ reason: "EVIDENCE_BOUND_EXCEEDED" });
      const twoReads = preflight(transaction, high * 2);
      await twoReads("course", "findMany", query);
      await twoReads("course", "findMany", query);
    });
  });

  it("weights the native legacy-terminal shared-five and singleton-one batches without losing cumulative byte charges", async () => {
    await withFixture(async (transaction, fixture) => {
      const key = `${fixture.batchId}-weighted`;
      const singletonBatchId = `${key}-singleton`;
      const additionalCourses = Array.from({ length: 4 }, (_, index) => `${key}-course-${index}`);
      await transaction.course.createMany({ data: additionalCourses.map((id) => ({
        id, name: "Local weighted batch proof", latitude: 41, longitude: -73,
      })) });
      await transaction.courseSupportIncident.createMany({ data: additionalCourses.map((courseId, index) => ({
        id: `${key}-incident-${index}`, reference: `${key}-incident-ref-${index}`, courseId,
        kind: "NEEDS_ADAPTER", courseNameSnapshot: "Local weighted batch proof", platformSnapshot: "UNKNOWN",
      })) });
      const finishedAt = new Date("2026-09-30T00:00:00.123Z");
      const batchData = { status: "SUCCEEDED" as const, completedAt: finishedAt,
        releaseSha: "a".repeat(40), deployedAt: finishedAt };
      await transaction.courseSupportBatch.update({ where: { id: fixture.batchId }, data: {
        ...batchData, summary: { marker: "shared-five", text: "s".repeat(512) },
      }, select: { id: true } });
      await transaction.courseSupportBatch.create({ data: { id: singletonBatchId, reference: `${key}-singleton-ref`,
        providerFamilyKey: "LOCAL_PROOF", failureFingerprint: "LOCAL_PROOF", leaseToken: "local-only",
        leaseExpiresAt: finishedAt, heartbeatAt: finishedAt, baseSha: "a".repeat(40), ...batchData,
        summary: { marker: "singleton-once", text: "x".repeat(256 * 1_024) },
      }, select: { id: true } });
      await transaction.courseSupportBatchIncident.updateMany({ where: { batchId: fixture.batchId }, data: {
        result: "FINAL_DISPOSITION", verifiedAt: finishedAt, verifiedIncidentUpdatedAt: finishedAt,
      } });
      await transaction.courseSupportBatchIncident.createMany({ data: additionalCourses.map((courseId, index) => ({
        id: `${key}-entry-${index}`, batchId: index === 3 ? singletonBatchId : fixture.batchId,
        incidentId: `${key}-incident-${index}`, courseId, cycle: 1, result: "FINAL_DISPOSITION",
        proofSnapshot: { local: true }, verifiedAt: finishedAt, verifiedIncidentUpdatedAt: finishedAt,
      })) });

      // Match the native legacy-terminal relation/scalar projection. The scope
      // remains local to this rollback fixture and contains all six entries.
      const query = { where: { batchId: { in: [fixture.batchId, singletonBatchId] }, result: "FINAL_DISPOSITION" as const,
        verifiedAt: { not: null }, verifiedIncidentUpdatedAt: { not: null },
        batch: { status: { in: ["SUCCEEDED", "PARTIAL"] as CourseSupportBatchStatus[] },
          completedAt: { gte: new Date("2026-01-01T00:00:00.000Z") }, releaseSha: { not: null }, deployedAt: { not: null } },
      }, orderBy: [{ batch: { completedAt: "desc" as const } }, { id: "desc" as const }], select: {
        id: true, batchId: true, incidentId: true, courseId: true, cycle: true, result: true, proofSnapshot: true,
        verifiedAt: true, verifiedIncidentUpdatedAt: true, createdAt: true, updatedAt: true,
        batch: { select: { id: true, status: true, createdAt: true, completedAt: true, releaseSha: true,
          deployedAt: true, recheckDispatchStartedAt: true, summary: true } },
      } };
      const native = await transaction.courseSupportBatchIncident.findMany(query);
      expect(native).toHaveLength(6);
      expect(native.filter((entry) => entry.batch.id === fixture.batchId)).toHaveLength(5);
      expect(native.filter((entry) => entry.batch.id === singletonBatchId)).toHaveLength(1);
      const nativeBytes = Buffer.byteLength(JSON.stringify(native), "utf8");

      // Independently compute selected scalar encoding and existing typed pads
      // on PostgreSQL, without calling the preflight's SQL-expression builder.
      const incidentPadding = 4 * 32 + Math.max(...Object.values(CourseSupportBatchIncidentResult)
        .map((value) => Buffer.byteLength(JSON.stringify(value), "utf8")));
      const batchPadding = 4 * 32 + Math.max(...Object.values(CourseSupportBatchStatus)
        .map((value) => Buffer.byteLength(JSON.stringify(value), "utf8")));
      const entryBytes = await transaction.$queryRaw<Array<{ id: string; bytes: bigint }>>(Prisma.sql`
        SELECT "id", (octet_length(jsonb_build_object(
          'id', "id", 'batchId', "batchId", 'incidentId', "incidentId", 'courseId', "courseId",
          'cycle', "cycle", 'result', "result", 'proofSnapshot', "proofSnapshot", 'verifiedAt', "verifiedAt",
          'verifiedIncidentUpdatedAt', "verifiedIncidentUpdatedAt", 'createdAt', "createdAt", 'updatedAt', "updatedAt"
        )::text) + ${incidentPadding}::bigint)::bigint AS bytes
        FROM "CourseSupportBatchIncident" WHERE "batchId" IN (${fixture.batchId}, ${singletonBatchId})
      `);
      const batchBytes = await transaction.$queryRaw<Array<{ id: string; bytes: bigint }>>(Prisma.sql`
        SELECT "id", (octet_length(jsonb_build_object(
          'id', "id", 'status', "status", 'createdAt', "createdAt", 'completedAt', "completedAt",
          'releaseSha', "releaseSha", 'deployedAt', "deployedAt", 'recheckDispatchStartedAt', "recheckDispatchStartedAt",
          'summary', "summary"
        )::text) + ${batchPadding}::bigint)::bigint AS bytes
        FROM "CourseSupportBatch" WHERE "id" IN (${fixture.batchId}, ${singletonBatchId})
      `);
      expect(entryBytes).toHaveLength(6);
      expect(batchBytes).toHaveLength(2);
      const bytesByBatch = new Map(batchBytes.map((row) => [row.id, row.bytes]));
      const envelope = (length: number) => BigInt(2 + Math.max(0, length - 1) +
        length * (Buffer.byteLength(JSON.stringify("batch"), "utf8") + 2));
      const expectedCharge = 2n * (envelope(native.length) + entryBytes.reduce((sum, row) => sum + row.bytes, 0n) +
        5n * bytesByBatch.get(fixture.batchId)! + bytesByBatch.get(singletonBatchId)!);
      const oldMaximumMultiplicityCharge = 2n * (envelope(native.length) +
        entryBytes.reduce((sum, row) => sum + row.bytes, 0n) +
        5n * (bytesByBatch.get(fixture.batchId)! + bytesByBatch.get(singletonBatchId)!));
      expect(expectedCharge).toBeGreaterThanOrEqual(BigInt(nativeBytes) * 2n);
      expect(oldMaximumMultiplicityCharge - expectedCharge).toBe(8n * bytesByBatch.get(singletonBatchId)!);
      expect(expectedCharge * 2n).toBeLessThan(BigInt(EVIDENCE_BYTES));
      const minimum = await minimumAllowance(transaction, "courseSupportBatchIncident", query, nativeBytes);
      expect(BigInt(minimum)).toBe(expectedCharge);

      const statements: Prisma.Sql[] = [];
      const recording = new Proxy(transaction, { get(target, property) {
        if (property === "$queryRaw") return async (statement: Prisma.Sql) => {
          statements.push(statement);
          return transaction.$queryRaw(statement);
        };
        return Reflect.get(target, property);
      } });
      await preflight(recording, minimum)("courseSupportBatchIncident", "findMany", query);
      const batchStatement = statements.find((statement) => statement.text.includes('FROM "CourseSupportBatch" AS acceptance_row'))!;
      expect(batchStatement.text).toContain("* acceptance_weight.occurrences");
      expect(batchStatement.text).toContain("AS acceptance_weight(identity, occurrences)");
      const weights = new Map([...batchStatement.text.matchAll(/\(\$(\d+)::text,\s*\$(\d+)::bigint\)/gu)]
        .map((match) => [batchStatement.values[Number(match[1]) - 1], batchStatement.values[Number(match[2]) - 1]]));
      expect(weights).toEqual(new Map([[fixture.batchId, 5n], [singletonBatchId, 1n]]));
      expect(batchStatement.text).not.toContain(fixture.batchId);
      expect(batchStatement.text).not.toContain(singletonBatchId);
      await expect(preflight(transaction, minimum - 1)("courseSupportBatchIncident", "findMany", query))
        .rejects.toMatchObject({ reason: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES" });

      const twoReads = preflight(transaction, minimum * 2);
      await twoReads("courseSupportBatchIncident", "findMany", query);
      await twoReads("courseSupportBatchIncident", "findMany", query);
      const oneByteShort = preflight(transaction, minimum * 2 - 1);
      await oneByteShort("courseSupportBatchIncident", "findMany", query);
      await expect(oneByteShort("courseSupportBatchIncident", "findMany", query)).rejects.toMatchObject({
        reason: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES",
      });
      expect(await transaction.courseSupportBatchIncident.findMany(query)).toEqual(native);

      const uniformQuery = { ...query, where: { ...query.where, batchId: fixture.batchId } };
      const uniformCharge = Number(2n * (envelope(5) + entryBytes.filter((row) =>
        native.some((entry) => entry.id === row.id && entry.batchId === fixture.batchId))
        .reduce((sum, row) => sum + row.bytes, 0n) + 5n * bytesByBatch.get(fixture.batchId)!));
      await preflight(transaction, uniformCharge)("courseSupportBatchIncident", "findMany", uniformQuery);
      await expect(preflight(transaction, uniformCharge - 1)("courseSupportBatchIncident", "findMany", uniformQuery))
        .rejects.toMatchObject({ reason: "EVIDENCE_BOUND_EXCEEDED", boundary: "SELECTED_EVIDENCE_BYTES" });
    });
  }, 40_000);

  it("bounds empty native result array syntax before hydration", async () => {
    await withFixture(async (transaction, fixture) => {
      await assertNativeBound(transaction, "course", { where: { id: `${fixture.courseIds[0]}-absent` }, select: { id: true } });
    });
  });
});
