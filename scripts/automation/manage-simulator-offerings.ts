import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Prisma } from "@prisma/client";

import { prisma } from "../../src/lib/prisma";
import { getTimeZoneForCoordinates } from "../../src/lib/timezones";

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
  maxPartySize: z.number().int().min(1).max(8).nullable().default(null),
  supportedDurationsMinutes: z.array(z.number().int().min(60).max(240).multipleOf(30)).max(7),
  providerFamilyKey: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/).optional(),
  bookingWindowDaysAhead: z.number().int().min(1).max(365).optional(),
  providerMetadata: z.record(z.string(), z.json()).optional()
}).strict();

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
  if (!options.apply) return { mode: "dry-run", offerings: rows.map((row) => ({ ...row, kind: "SIMULATOR", monitoringState: "UNKNOWN" })) };
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl || new URL(databaseUrl).hostname !== options.expectedDatabaseHost) {
    throw new Error("The loaded database does not match the explicitly expected database host");
  }
  const results = [];
  for (const row of rows) {
    const result = await prisma.$transaction(async (transaction) => {
      const alias = await transaction.googlePlaceReview.findUnique({ where: { googlePlaceId: row.googlePlaceId } });
      if (alias?.active && alias.canonicalPlaceId && alias.canonicalPlaceId !== row.googlePlaceId) {
        throw new Error("Review the canonical Google Place ID instead of an alias");
      }
      // Existing venue/outdoor intelligence stays intact. A new shared identity
      // begins pending public-course access; only this rental is reviewed here.
      const course = await transaction.course.upsert({
        where: { googlePlaceId: row.googlePlaceId }, update: {},
        create: { googlePlaceId: row.googlePlaceId, name: row.name, address: row.address,
          latitude: row.latitude, longitude: row.longitude,
          timeZone: getTimeZoneForCoordinates(row.latitude, row.longitude), website: row.website,
          ...(row.phone ? { phone: row.phone } : {}), isPublic: false }
      });
      const offeringData = {
        active: row.active, publicAccessStatus: row.publicAccessStatus, bookingUrl: row.bookingUrl,
        evidenceUrl: row.evidenceUrl, verifiedAt: new Date(row.verifiedAt), maxPartySize: row.maxPartySize,
        supportedDurationsMinutes: row.supportedDurationsMinutes,
        providerFamilyKey: row.providerFamilyKey ?? null,
        bookingWindowDaysAhead: row.bookingWindowDaysAhead ?? null,
        // Metadata is operator-reviewed JSON; Prisma serializes it without executing it.
        providerMetadata: row.providerMetadata ?? Prisma.DbNull,
        automationEligibility: "UNKNOWN" as const, monitoringState: "UNKNOWN" as const, monitoringVerifiedAt: null,
        observationToken: null, observationExpiresAt: null
      };
      const offering = await transaction.courseOffering.upsert({
        where: { courseId_kind: { courseId: course.id, kind: "SIMULATOR" } },
        create: { courseId: course.id, kind: "SIMULATOR", ...offeringData, monitoringRevision: 1 },
        update: { ...offeringData, monitoringRevision: { increment: 1 } }
      });
      return { googlePlaceId: row.googlePlaceId, courseId: course.id, offeringId: offering.id };
    });
    results.push(result);
  }
  return { mode: "applied", offerings: results };
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
