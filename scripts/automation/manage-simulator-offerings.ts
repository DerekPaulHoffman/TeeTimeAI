import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "../../src/lib/prisma";
import { getTimeZoneForCoordinates } from "../../src/lib/timezones";
import { runWithCourseSupportWriterTransitionLease, withCourseSupportWriteConflictRetry } from "../../src/lib/automation/course-support-batches";
import { hasSimulatorSupportOwnership } from "../../src/lib/automation/simulator-support-incidents";

const CLASSIFICATION_EVIDENCE_MAX_AGE_MS = 30 * 60_000;

const evidenceUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
}, "Use an HTTP(S) URL without embedded credentials");

const offeringManifestSchema = z.object({
  googlePlaceId: z.string().min(3).max(200).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().trim().min(2).max(200),
  address: z.string().trim().min(3).max(400),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  website: evidenceUrl,
  phone: z.string().max(60).optional(),
  bookingUrl: evidenceUrl,
  evidenceUrl,
  verifiedAt: z.string().datetime().refine((value) => new Date(value).getTime() <= Date.now(), "Verification cannot be in the future"),
  active: z.boolean().default(true),
  publicAccessStatus: z.enum(["PUBLIC", "UNVERIFIED", "NOT_PUBLIC"]),
  notPublicReason: z.enum(["MEMBERS_ONLY", "NOT_SIMULATOR_RENTAL"]).optional(),
  maxPartySize: z.number().int().min(1).max(8).nullable().default(null),
  supportedDurationsMinutes: z.array(z.number().int().min(60).max(240).multipleOf(30)).max(7),
  providerFamilyKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).optional(),
  bookingWindowDaysAhead: z.number().int().min(1).max(365).optional(),
  providerMetadata: z.record(z.string(), z.json()).optional()
}).strict().superRefine((row, context) => {
  if (!row.notPublicReason) return;
  if (row.publicAccessStatus !== "NOT_PUBLIC") {
    context.addIssue({ code: "custom", path: ["notPublicReason"], message: "An identity reason requires NOT_PUBLIC" });
  }
  if (new URL(row.evidenceUrl).hostname !== new URL(row.website).hostname) {
    context.addIssue({ code: "custom", path: ["evidenceUrl"], message: "Identity evidence must be on the reviewed official website" });
  }
  if (Date.now() - Date.parse(row.verifiedAt) > CLASSIFICATION_EVIDENCE_MAX_AGE_MS) {
    context.addIssue({ code: "custom", path: ["verifiedAt"], message: "Identity evidence must be verified within thirty minutes" });
  }
});

export type SimulatorOfferingManifest = z.infer<typeof offeringManifestSchema>;

export function parseSimulatorOfferingManifest(value: unknown): SimulatorOfferingManifest[] {
  const rows = z.array(offeringManifestSchema).min(1).max(50).parse(Array.isArray(value) ? value : [value]);
  if (new Set(rows.map((row) => row.googlePlaceId)).size !== rows.length) {
    throw new Error("A manifest must contain each exact Google Place ID only once");
  }
  for (const row of rows) rejectCredentialMetadata(row.providerMetadata);
  return rows.map((row) => ({ ...row, supportedDurationsMinutes: [...new Set(row.supportedDurationsMinutes)].sort((a, b) => a - b) }));
}

function rejectCredentialMetadata(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/token|secret|password|credential|api.?key|authorization|cookie|headers|bearer/i.test(key)) throw new Error("Provider metadata must not contain credentials");
    rejectCredentialMetadata(child);
  }
}

export function parseSimulatorOfferingCommand(args: string[]) {
  let manifestPath: string | undefined;
  let expectedDatabaseHost: string | undefined;
  let envFile: string | undefined;
  let apply = false;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--manifest") manifestPath = args[++index];
    else if (option === "--env-file") envFile = args[++index];
    else if (option === "--expected-database-host") expectedDatabaseHost = args[++index];
    else if (option === "--apply") apply = true;
    else throw new Error(`Unknown option: ${option}`);
  }
  if (!manifestPath) throw new Error("Supply --manifest <reviewed-json-file>; the default is a dry run");
  if (apply && !expectedDatabaseHost) throw new Error("Applying requires --expected-database-host <hostname> after reviewing the dry run");
  return { manifestPath, expectedDatabaseHost, envFile, apply };
}

export async function executeSimulatorOfferingManifest(rows: SimulatorOfferingManifest[], options: { apply: boolean; expectedDatabaseHost?: string }) {
  const reviewedRows = parseSimulatorOfferingManifest(rows);
  const intendedState = (row: SimulatorOfferingManifest) => row.notPublicReason
    ? { monitoringState: "FINAL_IDENTITY" as const, automationEligibility: "BLOCKED" as const }
    : { monitoringState: "UNKNOWN" as const, automationEligibility: "UNKNOWN" as const };
  if (!options.apply) return { mode: "dry-run", offerings: reviewedRows.map((row) => ({ ...row, kind: "SIMULATOR", ...intendedState(row),
    incidentDisposition: row.notPublicReason ? { status: "RESOLVED", reason: row.notPublicReason, evidenceUrl: row.evidenceUrl, resolvedAt: row.verifiedAt, retryAt: null } : null,
  })) };
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl || new URL(databaseUrl).hostname !== options.expectedDatabaseHost) {
    throw new Error("The loaded database does not match the explicitly expected database host");
  }
  const applied = await runWithCourseSupportWriterTransitionLease(() => withCourseSupportWriteConflictRetry(() => prisma.$transaction(async (transaction) => {
    const [clock] = await transaction.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS "now"`);
    if (!(clock?.now instanceof Date)) throw new Error("Simulator review database time is unavailable");
    const results = [];
    for (const row of [...reviewedRows].sort((left, right) => left.googlePlaceId.localeCompare(right.googlePlaceId))) {
      const alias = await transaction.googlePlaceReview.findUnique({ where: { googlePlaceId: row.googlePlaceId } });
      if (alias?.active && alias.canonicalPlaceId && alias.canonicalPlaceId !== row.googlePlaceId) {
        throw new Error("Review the canonical Google Place ID instead of an alias");
      }
      // Existing venue/outdoor intelligence stays intact. A new shared identity
      // begins pending public-course access; only this rental is reviewed here.
      await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "Course" WHERE "googlePlaceId" = ${row.googlePlaceId} FOR UPDATE`);
      const course = await transaction.course.upsert({
        where: { googlePlaceId: row.googlePlaceId }, update: {},
        create: { googlePlaceId: row.googlePlaceId, name: row.name, address: row.address,
          latitude: row.latitude, longitude: row.longitude,
          timeZone: getTimeZoneForCoordinates(row.latitude, row.longitude), website: row.website,
          ...(row.phone ? { phone: row.phone } : {}), isPublic: false }
      });
      await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "CourseOffering" WHERE "courseId" = ${course.id} AND "kind" = 'SIMULATOR' FOR UPDATE`);
      const existing = await transaction.courseOffering.findUnique({ where: { courseId_kind: { courseId: course.id, kind: "SIMULATOR" } } });
      if (existing) {
        if (await hasSimulatorSupportOwnership(transaction, existing.id)) throw new Error("A named simulator offering has live support ownership; preserve its owner");
        if ((existing.observationToken && !existing.observationExpiresAt) ||
            (existing.observationExpiresAt && existing.observationExpiresAt > clock.now)) {
          throw new Error("A named simulator offering has a live or ambiguous observation lease; preserve its observation");
        }
        await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "SimulatorSupportIncident" WHERE "offeringId" = ${existing.id} FOR UPDATE`);
      }
      if (row.notPublicReason && (new Date(row.verifiedAt) > clock.now ||
          new Date(row.verifiedAt).getTime() < clock.now.getTime() - CLASSIFICATION_EVIDENCE_MAX_AGE_MS ||
          (course.website && new URL(course.website).hostname !== new URL(row.website).hostname))) {
        throw new Error("Identity classification requires fresh evidence on the exact existing official website");
      }
      const offeringData = {
        active: row.active, publicAccessStatus: row.publicAccessStatus, bookingUrl: row.bookingUrl,
        evidenceUrl: row.evidenceUrl, verifiedAt: new Date(row.verifiedAt), maxPartySize: row.maxPartySize,
        supportedDurationsMinutes: row.supportedDurationsMinutes,
        providerFamilyKey: row.providerFamilyKey ?? null,
        bookingWindowDaysAhead: row.bookingWindowDaysAhead ?? null,
        // Metadata is operator-reviewed JSON; Prisma serializes it without executing it.
        providerMetadata: row.providerMetadata ?? Prisma.DbNull,
        ...intendedState(row), monitoringVerifiedAt: null,
        observationToken: null, observationExpiresAt: null
      };
      const offering = await transaction.courseOffering.upsert({
        where: { courseId_kind: { courseId: course.id, kind: "SIMULATOR" } },
        create: { courseId: course.id, kind: "SIMULATOR", ...offeringData, monitoringRevision: 1 },
        update: { ...offeringData, monitoringRevision: { increment: 1 } }
      });
      if (row.notPublicReason) await transaction.simulatorSupportIncident.updateMany({
        where: { offeringId: offering.id }, data: { status: "RESOLVED", reason: row.notPublicReason,
          evidenceUrl: row.evidenceUrl, resolvedAt: new Date(row.verifiedAt), retryAt: null },
      });
      results.push({ googlePlaceId: row.googlePlaceId, courseId: course.id, offeringId: offering.id, ...intendedState(row) });
    }
    return results;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15_000 })));
  if (!applied.acquired) throw new Error("Simulator review writer transition is busy; no manifest was applied");
  return { mode: "applied", offerings: applied.value };
}

async function main() {
  const command = parseSimulatorOfferingCommand(process.argv.slice(2));
  if (command.envFile) process.loadEnvFile(resolve(command.envFile));
  const rows = parseSimulatorOfferingManifest(JSON.parse(await readFile(command.manifestPath, "utf8")));
  console.log(JSON.stringify(await executeSimulatorOfferingManifest(rows, command), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "Simulator review failed"); process.exitCode = 1; })
    .finally(() => { if (process.argv.includes("--apply")) return prisma.$disconnect(); });
}
