// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.SIMULATOR_TEST_DATABASE_URL;
const migrationNames = ["20261005090000_add_simulator_offerings", "20261005160000_fence_simulator_match_source"];
const migrationsRoot = join(process.cwd(), "prisma", "migrations");
const snapshots = new Map<string, unknown>();
let admin: Client | undefined;
let database: Client | undefined;
let baselineCount = 0;

describe.skipIf(!databaseUrl)("simulator additive migration preserves existing demand and monitoring", () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !/^\/(simulator_preview|simulator_migration_[a-z0-9_]+)$/.test(url.pathname)) {
      throw new Error("Simulator migration tests require an explicitly named, isolated local simulator database");
    }
    const ownedName = `simulator_migration_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    admin = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000 });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${ownedName}"`);
    url.pathname = `/${ownedName}`;
    database = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5_000 });
    await database.connect();
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name < migrationNames[0])
      .map((entry) => entry.name).sort();
    baselineCount = migrations.length;
    for (const name of migrations) await applySqlFile(database, await readFile(join(migrationsRoot, name, "migration.sql"), "utf8"));
    await seedLegacyRows(database);
    for (const table of ["User", "Course", "TeeSearch", "CoursePreference", "CourseProbe", "TeeTimeMatch", "CourseMonitoringStatus", "GooglePlaceReview"]) {
      snapshots.set(table, await baselineSnapshot(database, table));
    }
    for (const name of migrationNames) await applySqlFile(database, await readFile(join(migrationsRoot, name, "migration.sql"), "utf8"));
    // The owned disposable database is retained for inspection; tests never drop
    // the caller's preview database or touch any existing fixture outside it.
    console.info(`Simulator migration receipt: ${ownedName}; ${baselineCount} baseline migrations + ${migrationNames.length} additive migrations`);
  }, 90_000);

  afterAll(async () => {
    await database?.end();
    await admin?.end();
  });

  it("applies the actual baseline and preserves every legacy row except newly added columns", async () => {
    expect(baselineCount).toBeGreaterThanOrEqual(52);
    for (const [table, before] of snapshots) expect(await baselineSnapshot(database!, table)).toEqual(before);
  });

  it("defaults existing searches outdoors and backfills precise offering foreign keys", async () => {
    const searches = await database!.query('SELECT "mode", "durationMinutes", "scheduleVersion", "workflowRunId" FROM "TeeSearch" ORDER BY "id"');
    expect(searches.rows).toEqual([{ mode: "OUTDOOR", durationMinutes: null, scheduleVersion: 3, workflowRunId: "legacy-workflow" }]);
    for (const table of ["CoursePreference", "CourseProbe", "TeeTimeMatch"]) {
      const rows = await database!.query(`SELECT "courseId", "offeringId" FROM "${table}" ORDER BY "id"`);
      for (const row of rows.rows) expect(row.offeringId).toBe(`outdoor-${row.courseId}`);
    }
    const fingerprint = await database!.query('SELECT "offeringSourceFingerprint" FROM "TeeTimeMatch" WHERE "id"=$1', ["legacy-match"]);
    expect(fingerprint.rows).toEqual([{ offeringSourceFingerprint: null }]);
    const offerings = await database!.query(`SELECT "courseId", "kind", "publicAccessStatus", "bookingUrl" FROM "CourseOffering" WHERE "courseId" LIKE 'legacy-%' ORDER BY "courseId"`);
    expect(offerings.rows).toEqual([
      { courseId: "legacy-hybrid", kind: "OUTDOOR", publicAccessStatus: "PUBLIC", bookingUrl: "https://outdoor.example/hybrid/tee-times" },
      { courseId: "legacy-private", kind: "OUTDOOR", publicAccessStatus: "NOT_PUBLIC", bookingUrl: "https://private.example/tee-times" },
      { courseId: "legacy-public", kind: "OUTDOOR", publicAccessStatus: "PUBLIC", bookingUrl: "https://outdoor.example/public/tee-times" }
    ]);
  });

  it("keeps simulator public access, booking URLs and health independent of hybrid and excluded outdoor rows", async () => {
    await database!.query(`INSERT INTO "CourseOffering" ("id","courseId","kind","publicAccessStatus","bookingUrl","evidenceUrl","verifiedAt","maxPartySize","supportedDurationsMinutes","updatedAt")
      VALUES ('hybrid-simulator','legacy-hybrid','SIMULATOR','PUBLIC','https://sim.example/hybrid/bays','https://sim.example/hybrid',CURRENT_TIMESTAMP,6,ARRAY[60,120],CURRENT_TIMESTAMP),
      ('private-venue-simulator','legacy-private','SIMULATOR','PUBLIC','https://sim.example/public-bays','https://sim.example/public-rentals',CURRENT_TIMESTAMP,6,ARRAY[120],CURRENT_TIMESTAMP)`);
    const simulator = await database!.query(`SELECT "kind","publicAccessStatus","monitoringState","bookingUrl" FROM "CourseOffering" WHERE "id"='private-venue-simulator'`);
    expect(simulator.rows[0]).toEqual({ kind: "SIMULATOR", publicAccessStatus: "PUBLIC", monitoringState: "UNKNOWN", bookingUrl: "https://sim.example/public-bays" });
    expect(await baselineSnapshot(database!, "Course")).toEqual(snapshots.get("Course"));
    expect(await baselineSnapshot(database!, "CourseMonitoringStatus")).toEqual(snapshots.get("CourseMonitoringStatus"));
    expect(await baselineSnapshot(database!, "GooglePlaceReview")).toEqual(snapshots.get("GooglePlaceReview"));
  });

  it("enforces per-venue offering uniqueness and refuses dangling preference offering IDs", async () => {
    await expect(database!.query(`INSERT INTO "CourseOffering" ("id","courseId","kind","updatedAt") VALUES ('duplicate-simulator','legacy-hybrid','SIMULATOR',CURRENT_TIMESTAMP)`))
      .rejects.toMatchObject({ code: "23505" });
    await expect(database!.query(`UPDATE "CoursePreference" SET "offeringId"='missing-offering' WHERE "id"='legacy-preference-public'`))
      .rejects.toMatchObject({ code: "23503" });
    expect(await baselineSnapshot(database!, "CoursePreference")).toEqual(snapshots.get("CoursePreference"));
  });
});

async function baselineSnapshot(client: Client, table: string) {
  const extraColumns = table === "TeeSearch" ? ["mode", "durationMinutes"] : table === "TeeTimeMatch" ?
    ["offeringId", "endsAt", "resourceId", "productId", "priceBasis", "currency", "capacity", "offeringSourceFingerprint"] :
    ["CoursePreference", "CourseProbe"].includes(table) ? ["offeringId"] : [];
  const result = await client.query(`SELECT to_jsonb(record) - $1::text[] AS row FROM "${table}" record ORDER BY (to_jsonb(record) - $1::text[])::text`, [extraColumns]);
  return result.rows.map((row) => row.row);
}

async function applySqlFile(client: Client, sql: string) {
  // pg sends a multi-statement string in an implicit transaction. Execute at
  // statement boundaries instead, honoring the migration's own BEGIN/COMMIT.
  // This lets historical enum additions commit before subsequent statements use
  // the new value, while keeping quoted function bodies and comments intact.
  let start = 0;
  let quote: string | null = null;
  let dollarTag: string | null = null;
  let lineComment = false;
  let blockDepth = 0;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    const next = sql[index + 1];
    if (lineComment) { if (char === "\n") lineComment = false; continue; }
    if (blockDepth) {
      if (char === "/" && next === "*") { blockDepth++; index++; }
      else if (char === "*" && next === "/") { blockDepth--; index++; }
      continue;
    }
    if (quote) {
      if (char === quote && next === quote) index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, index)) { index += dollarTag.length - 1; dollarTag = null; }
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; index++; continue; }
    if (char === "/" && next === "*") { blockDepth = 1; index++; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "$") {
      const match = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) { dollarTag = match[0]; index += dollarTag.length - 1; continue; }
    }
    if (char === ";") { await client.query(sql.slice(start, index + 1)); start = index + 1; }
  }
  if (sql.slice(start).trim()) await client.query(sql.slice(start));
}

async function seedLegacyRows(client: Client) {
  await client.query(`
    INSERT INTO "User" ("id","clerkUserId","email","updatedAt") VALUES ('legacy-user','migration-fixture-clerk','migration-owner@example.test','2026-10-01T12:00:00Z');
    INSERT INTO "Course" ("id","googlePlaceId","name","latitude","longitude","isPublic","detectedBookingUrl","providerFamilyKey","automationEligibility","layoutHoleCounts","layoutHolesVerifiedAt","updatedAt") VALUES
      ('legacy-public','fixture-public-place','Public Fixture Course',41.2,-73.2,true,'https://outdoor.example/public/tee-times','FOREUP','ALLOWED',ARRAY[18],'2026-10-01T12:00:00Z','2026-10-01T12:00:00Z'),
      ('legacy-private','fixture-private-place','Excluded Fixture Venue',41.21,-73.21,false,'https://private.example/tee-times','UNKNOWN','BLOCKED',ARRAY[]::integer[],NULL,'2026-10-01T12:00:00Z'),
      ('legacy-hybrid','fixture-hybrid-place','Hybrid Fixture Venue',41.22,-73.22,true,'https://outdoor.example/hybrid/tee-times','FOREUP','ALLOWED',ARRAY[9,18],'2026-10-01T12:00:00Z','2026-10-01T12:00:00Z');
    INSERT INTO "TeeSearch" ("id","userId","date","startTime","endTime","players","status","checkStatus","scheduleVersion","workflowRunId","nextCheckAt","updatedAt")
      VALUES ('legacy-search','legacy-user','2026-10-10','09:00','12:00',2,'ACTIVE','WAITING',3,'legacy-workflow','2026-10-05T20:00:00Z','2026-10-01T12:00:00Z');
    INSERT INTO "CoursePreference" ("id","teeSearchId","courseId","rank") VALUES
      ('legacy-preference-public','legacy-search','legacy-public',1),('legacy-preference-hybrid','legacy-search','legacy-hybrid',2);
    INSERT INTO "CourseProbe" ("id","teeSearchId","courseId","outcome","observedAt","message","rawSummary") VALUES
      ('legacy-probe-public','legacy-search','legacy-public','NO_MATCH','2026-10-01T12:00:00Z','Outdoor check succeeded','{"fixture":"outdoor-success"}'),
      ('legacy-probe-private','legacy-search','legacy-private','BLOCKED_POLICY','2026-10-01T12:00:00Z','Historical identity exclusion','{"fixture":"legacy-identity"}');
    INSERT INTO "TeeTimeMatch" ("id","teeSearchId","courseId","sourceId","startsAt","availableSpots","priceCents","holes","bookingUrl","alertStatus","sentAt")
      VALUES ('legacy-match','legacy-search','legacy-public','legacy-slot','2026-10-10T14:00:00Z',2,12000,18,'https://outdoor.example/public/tee-times','SENT','2026-10-01T12:00:00Z');
    INSERT INTO "CourseMonitoringStatus" ("courseId","reference","state","lastSuccessfulAt","revision","updatedAt") VALUES
      ('legacy-public','fixture-public-monitoring','HEALTHY','2026-10-01T12:00:00Z',7,'2026-10-01T12:00:00Z'),
      ('legacy-private','fixture-private-monitoring','FINAL_IDENTITY',NULL,11,'2026-10-01T12:00:00Z');
    INSERT INTO "GooglePlaceReview" ("id","googlePlaceId","accessOverride","name","classification","evidenceUrl","reviewedAt","updatedAt")
      VALUES ('fixture-private-review','fixture-private-place','VERIFIED_NON_COURSE','Excluded Fixture Venue','INDOOR_SIMULATOR','https://fixture.example/identity','2026-10-01T12:00:00Z','2026-10-01T12:00:00Z');
  `);
}
