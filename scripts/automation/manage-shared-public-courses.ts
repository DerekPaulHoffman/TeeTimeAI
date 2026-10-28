import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../src/lib/prisma";
import { isForeupMetadata } from "../../src/lib/adapters/foreup";
import { readForeupStandardPublicSchedule, type ForeupPublicConfiguration } from "../../src/lib/automation/foreup-public-configuration";
import { runWithProviderRequestLease } from "../../src/lib/automation/provider-request-lease";

// Explicit operator preparation. No discovery GET, dashboard render, or alert
// creation creates facility members. Default is read-only except request leases.
const planSchema = z.object({
  rootCourseId: z.string().min(1),
  courses: z.array(z.object({
    existingCourseId: z.string().min(1).optional(), name: z.string().min(1).max(200),
    scheduleId: z.number().int().positive(), bookingClassId: z.number().int().positive(),
    layoutHoles: z.union([z.literal(9), z.literal(18)]),
    layoutEvidenceUrl: z.url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }),
  }).strict()).min(2).max(10),
}).strict();

async function main() {
  const { values } = parseArgs({ options: { plan: { type: "string" }, apply: { type: "boolean", default: false }, "expected-database-host": { type: "string" } } });
  if (!values.plan) throw new Error("Provide --plan <json-file>; --apply requires --expected-database-host.");
  const input = planSchema.parse(JSON.parse(await readFile(values.plan, "utf8")));
  const root = await prisma.course.findUniqueOrThrow({ where: { id: input.rootCourseId } });
  if (root.isPublic !== true || root.providerFamilyKey !== "FOREUP" || !isForeupMetadata(root.bookingMetadata)) throw new Error("Root must be a verified public ForeUP course.");
  const rootMetadata = root.bookingMetadata as Prisma.JsonObject;
  const metadata = root.bookingMetadata;
  const source = new URL(metadata.bookingBaseUrl);
  const facilityId = /^\/index\.php\/booking\/(?:index\/)?([1-9]\d*)(?:\/[1-9]\d*)?\/?$/u.exec(source.pathname)?.[1];
  if (source.protocol !== "https:" || source.hostname !== "foreupsoftware.com" || source.username || source.password || source.search || !facilityId) throw new Error("Root official booking source is invalid.");
  const primary = input.courses.filter(row => row.existingCourseId === root.id);
  if (primary.length !== 1 || primary[0].name !== root.name || primary[0].scheduleId !== metadata.scheduleId || primary[0].bookingClassId !== metadata.bookingClassId ||
      input.courses.some(row => row.existingCourseId && row.existingCourseId !== root.id) ||
      new Set(input.courses.map(row => row.scheduleId)).size !== input.courses.length) throw new Error("Preserve the exact existing primary course and distinct physical sheets.");
  const verified: Array<z.infer<typeof planSchema>["courses"][number] & { id: string; configuration: ForeupPublicConfiguration }> = [];
  for (const row of input.courses) {
    const result = await runWithProviderRequestLease("FOREUP", () => readForeupStandardPublicSchedule({
      bookingUrl: `https://foreupsoftware.com/index.php/booking/${facilityId}#/teetimes`,
      courseName: row.name, scheduleId: row.scheduleId, bookingClassId: row.bookingClassId,
    }));
    if (!result.acquired || !result.value) throw new Error("Exact public course/schedule/class verification failed or is busy. Nothing was applied.");
    const id = row.existingCourseId ?? `public-course-${createHash("sha256").update(`${root.id}|${row.scheduleId}`).digest("hex").slice(0, 24)}`;
    verified.push({ ...row, id, configuration: result.value });
  }
  const observedAt = new Date();
  const scope = { rootCourseId: root.id, courseIds: verified.map(row => row.id), sourceBookingUrl: verified[0].configuration.sourceBookingUrl, verifiedAt: observedAt.toISOString() };
  const databaseHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : null;
  console.log(JSON.stringify({ apply: values.apply, databaseHost, courses: verified.map(row => ({ id: row.id, name: row.name, layoutHoles: row.layoutHoles, bookingUrl: row.configuration.bookingBaseUrl })) }, null, 2));
  if (!values.apply) return;
  if (!databaseHost || values["expected-database-host"] !== databaseHost) throw new Error("Confirm the exact database host before applying this reviewed plan.");
  await prisma.$transaction(async tx => {
    for (const row of verified.filter(row => row.id !== root.id)) {
      const existing = await tx.course.findUnique({ where: { id: row.id } });
      if (existing && (existing.name !== row.name || existing.isPublic !== true ||
          !isForeupMetadata(existing.bookingMetadata) || existing.bookingMetadata.scheduleId !== row.scheduleId || existing.bookingMetadata.bookingClassId !== row.bookingClassId)) throw new Error("Existing member identity conflicts; nothing was applied.");
      const bookingMetadata = { ...(existing?.bookingMetadata as Prisma.JsonObject | undefined), scheduleId: row.scheduleId, bookingClassId: row.bookingClassId,
        bookingBaseUrl: row.configuration.bookingBaseUrl, sharedFacility: scope };
      await tx.course.upsert({ where: { id: row.id }, update: { bookingMetadata }, create: {
        id: row.id, name: row.name, address: root.address, latitude: root.latitude, longitude: root.longitude,
        city: root.city, stateCode: root.stateCode, stateName: root.stateName, county: root.county, countryCode: root.countryCode,
        timeZone: root.timeZone, website: root.website, phone: root.phone, isPublic: true,
        detectedPlatform: "FOREUP", providerFamilyKey: "FOREUP", detectedBookingUrl: row.configuration.bookingBaseUrl,
        bookingMethod: "PUBLIC_ONLINE", bookingAccessMode: "PUBLIC_SIGNED_OUT", automationEligibility: "ALLOWED", bookingMetadata,
        layoutHoleCounts: [row.layoutHoles], layoutHolesEvidenceUrl: row.layoutEvidenceUrl, layoutHolesVerifiedAt: observedAt,
      } });
    }
    const updated = await tx.course.updateMany({ where: { id: root.id, bookingMetadata: { equals: rootMetadata } }, data: {
      bookingMetadata: { ...rootMetadata, sharedFacility: scope },
    } });
    if (updated.count !== 1) throw new Error("Primary metadata changed during preparation; nothing was applied.");
  });
  const saved = await prisma.course.findMany({ where: { id: { in: scope.courseIds } }, select: { id: true, name: true, layoutHoleCounts: true, bookingMetadata: true } });
  if (saved.length !== scope.courseIds.length) throw new Error("Member read-back incomplete.");
  console.log(JSON.stringify({ applied: true, verifiedCourseCount: saved.length }));
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Shared course setup failed"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
