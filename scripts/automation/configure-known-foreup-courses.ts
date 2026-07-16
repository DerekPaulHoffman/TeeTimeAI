import "./load-local-env";

import { Prisma } from "@prisma/client";

import {
  reconcileKnownForeupMonitoring,
  selectKnownForeupCourses
} from "@/lib/automation/known-foreup-courses";
import { prisma } from "@/lib/prisma";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const requestedName = readOption(args, "--name");
  const knownForeupCourses = selectKnownForeupCourses(requestedName);
  if (knownForeupCourses.length === 0) {
    throw new Error("No known ForeUP course matched --name.");
  }
  const results = [];

  for (const course of knownForeupCourses) {
    const matches = await prisma.course.findMany({
      where: {
        name: course.name,
        ...(course.stateCode ? { stateCode: course.stateCode } : {})
      },
      select: {
        id: true,
        updatedAt: true,
        automationEligibility: true,
        automationReason: true,
        bookingMetadata: true,
        policyNotes: true,
        intelligenceConfidence: true,
        automationDiscoveries: {
          orderBy: { createdAt: "desc" },
          take: 10,
          select: { sourceUrl: true }
        }
      }
    });
    if (apply && matches.length !== 1) {
      throw new Error("ForeUP configuration requires exactly one matching course.");
    }
    let updated = 0;
    if (apply) {
      for (const match of matches) {
        await prisma.$transaction(async (tx) => {
          const observedAt = new Date();
          const monitoring = reconcileKnownForeupMonitoring(course, match);
          const result = await tx.course.updateMany({
            where: { id: match.id, updatedAt: match.updatedAt },
            data: {
              detectedPlatform: "FOREUP",
              providerFamilyKey: "FOREUP",
              automationEligibility: monitoring.automationEligibility,
              bookingMethod: "PUBLIC_ONLINE",
              automationReason: monitoring.automationReason,
              intelligenceVerifiedAt: observedAt,
              intelligenceConfidence: monitoring.confidence,
              detectedBookingUrl: monitoring.detectedBookingUrl,
              policyNotes: monitoring.policyNotes,
              bookingMetadata: monitoring.bookingMetadata ?? Prisma.DbNull,
              ...(course.officialWebsite ? { website: course.officialWebsite } : {}),
              ...(course.layoutHoleCounts
                ? {
                    layoutHoleCounts: course.layoutHoleCounts,
                    layoutHolesEvidenceUrl: course.layoutEvidenceUrl,
                    layoutHolesVerifiedAt: observedAt
                  }
                : {})
            }
          });
          if (result.count !== 1) {
            throw new Error("Course evidence changed during ForeUP configuration.");
          }
          const hasSourceDiscovery = match.automationDiscoveries.some(
            (discovery) => discovery.sourceUrl === course.officialSourceUrl
          );
          if (course.officialSourceUrl && !hasSourceDiscovery) {
            await tx.courseAutomationDiscovery.create({
              data: {
                courseId: match.id,
                status:
                  monitoring.automationEligibility === "BLOCKED"
                    ? "BLOCKED"
                    : monitoring.bookingMetadata
                      ? "LEARNED"
                      : "INSPECTED",
                detectedPlatform: "FOREUP",
                bookingMethod: "PUBLIC_ONLINE",
                automationEligibility: monitoring.automationEligibility,
                automationReason: monitoring.automationReason,
                sourceUrl: course.officialSourceUrl,
                bookingUrl: monitoring.detectedBookingUrl,
                apiEndpoint: monitoring.bookingMetadata
                  ? "https://foreupsoftware.com/index.php/api/booking/times"
                  : null,
                apiMetadata: monitoring.bookingMetadata ?? Prisma.DbNull,
                confidence: monitoring.confidence,
                evidence: {
                  learnedFrom: "official-course-site-booking-link",
                  observedUrls: [
                    course.officialSourceUrl,
                    monitoring.detectedBookingUrl
                  ]
                }
              }
            });
          }
          updated += 1;
        });
      }
    }

    results.push({
      course: course.name,
      matched: matches.length,
      updated,
      metadataReady: Boolean(course.bookingMetadata)
    });
  }

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry_run", results }, null, 2));
}

function readOption(args: string[], name: string) {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1]?.trim();
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  })
  .catch(() => {
    console.error(JSON.stringify({ ok: false, error: "KNOWN_FOREUP_CONFIGURATION_FAILED" }));
    process.exitCode = 1;
  });
