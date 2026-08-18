import "./load-local-env";

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  MAX_BOOKING_WINDOW_DAYS_AHEAD,
  normalizeReleaseTime
} from "@/lib/courses/booking-window";
import { recordCourseBookingWindowEvidence } from "@/lib/automation/db-service";
import { applyCourseProfileDraft, createCourseProfileSlugAlias, getCourseProfileResearchPacket, listCourseProfileQueue } from "@/lib/course-profiles/service";
import { prisma } from "@/lib/prisma";

export function parseCourseProfileCommand(args: readonly string[]) {
  const action = args[0];
  const apply = args.includes("--apply");
  const value = (option: string) => {
    const index = args.indexOf(option);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (action === "queue") return { action, limit: Number(value("--limit") ?? 3) } as const;
  if (action === "cohort") return { action } as const;
  if (action === "verify-profiles") {
    const stateCode = value("--state")?.trim().toUpperCase();
    if (!stateCode || !/^[A-Z]{2}$/.test(stateCode)) {
      throw new Error("verify-profiles requires a two-letter --state");
    }
    return { action, stateCode } as const;
  }
  if (action === "research") {
    const courseId = value("--course-id");
    if (!courseId) throw new Error("research requires --course-id");
    return { action, courseId } as const;
  }
  if (action === "booking-window") {
    const courseId = value("--course-id");
    const daysAheadValue = value("--days-ahead");
    const releaseTimeValue = value("--release-time");
    const evidenceUrl = value("--evidence-url");
    if (!courseId || daysAheadValue === undefined || !evidenceUrl) {
      throw new Error(
        "booking-window requires --course-id, --days-ahead, and --evidence-url"
      );
    }
    const daysAhead = Number(daysAheadValue);
    if (
      !Number.isInteger(daysAhead) ||
      daysAhead < 0 ||
      daysAhead > MAX_BOOKING_WINDOW_DAYS_AHEAD
    ) {
      throw new Error(
        `--days-ahead must be an integer from 0 to ${MAX_BOOKING_WINDOW_DAYS_AHEAD}`
      );
    }
    const releaseTimeLocal = releaseTimeValue
      ? normalizeReleaseTime(releaseTimeValue)
      : null;
    if (releaseTimeValue && !releaseTimeLocal) {
      throw new Error("--release-time must be a valid course-local time");
    }
    let parsedEvidenceUrl: URL;
    try {
      parsedEvidenceUrl = new URL(evidenceUrl);
    } catch {
      throw new Error("--evidence-url must be an HTTP(S) URL");
    }
    if (
      !/^https?:$/.test(parsedEvidenceUrl.protocol) ||
      parsedEvidenceUrl.username ||
      parsedEvidenceUrl.password ||
      /^(?:localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/i.test(parsedEvidenceUrl.hostname)
    ) {
      throw new Error("--evidence-url must be an HTTP(S) URL");
    }
    return {
      action,
      courseId,
      daysAhead,
      releaseTimeLocal,
      evidenceUrl: parsedEvidenceUrl.toString(),
      apply
    } as const;
  }
  if (action === "alias") {
    const courseId = value("--course-id");
    const slug = value("--slug");
    if (!courseId || !slug) throw new Error("alias requires --course-id and --slug");
    return { action, courseId, slug, apply } as const;
  }
  if (action === "upsert") return { action, apply, file: value("--file") } as const;
  throw new Error('Expected "cohort", "queue", "research", "verify-profiles", "booking-window", "alias", or "upsert"');
}

export async function executeCourseProfileCommand(command: ReturnType<typeof parseCourseProfileCommand>, stdin = process.stdin) {
  if (command.action === "cohort") {
    return prisma.course.findMany({
      where: { automationEligibility: "ALLOWED", address: { contains: "CT" } },
      orderBy: { name: "asc" },
      select: {
        id: true, googlePlaceId: true, name: true, address: true, latitude: true, longitude: true,
        website: true, detectedBookingUrl: true, bookingWindowEvidenceUrl: true,
        bookingWindowDaysAhead: true, bookingReleaseTimeLocal: true
      }
    });
  }
  if (command.action === "queue") return listCourseProfileQueue(command.limit);
  if (command.action === "research") return getCourseProfileResearchPacket(command.courseId);
  if (command.action === "verify-profiles") {
    const courses = await prisma.course.findMany({
      where: {
        automationEligibility: "ALLOWED",
        OR: [
          { stateCode: command.stateCode },
          { address: { contains: `, ${command.stateCode}` } }
        ]
      },
      select: {
        profile: {
          select: {
            id: true,
            sources: { select: { id: true } }
          }
        }
      }
    });
    const missingProfiles = courses.filter((course) => !course.profile).length;
    const missingSources = courses.filter(
      (course) => course.profile && course.profile.sources.length === 0
    ).length;
    return {
      stateCode: command.stateCode,
      courses: courses.length,
      profiles: courses.length - missingProfiles,
      missingProfiles,
      missingSources,
      valid: missingProfiles === 0 && missingSources === 0
    };
  }
  if (command.action === "booking-window") {
    const course = await prisma.course.findUnique({
      where: { id: command.courseId },
      select: {
        id: true,
        name: true,
        bookingWindowDaysAhead: true,
        bookingReleaseTimeLocal: true,
        bookingWindowSource: true,
        bookingWindowConfidence: true,
        bookingWindowEvidenceUrl: true,
        bookingWindowCheckedAt: true,
        bookingWindowObservedAt: true
      }
    });
    if (!course) throw new Error(`Course ${command.courseId} was not found`);

    const proposed = {
      bookingWindowDaysAhead: command.daysAhead,
      bookingReleaseTimeLocal: command.releaseTimeLocal,
      bookingWindowSource: "OFFICIAL_BOOKING_PAGE" as const,
      bookingWindowConfidence: 1,
      bookingWindowEvidenceUrl: command.evidenceUrl
    };
    if (!command.apply) {
      return { apply: false, course, proposed };
    }

    const observedAt = new Date();
    const updated = await recordCourseBookingWindowEvidence({
      courseId: command.courseId,
      evidence: {
        daysAhead: command.daysAhead,
        releaseTimeLocal: command.releaseTimeLocal,
        source: "OFFICIAL_BOOKING_PAGE",
        confidence: 1,
        evidenceUrl: command.evidenceUrl
      },
      observedAt,
      source: "OPERATOR_CLI"
    });
    return {
      apply: true,
      course: {
        id: updated.id,
        name: updated.name,
        bookingWindowDaysAhead: updated.bookingWindowDaysAhead,
        bookingReleaseTimeLocal: updated.bookingReleaseTimeLocal,
        bookingWindowSource: updated.bookingWindowSource,
        bookingWindowConfidence: updated.bookingWindowConfidence,
        bookingWindowEvidenceUrl: updated.bookingWindowEvidenceUrl,
        bookingWindowCheckedAt: updated.bookingWindowCheckedAt,
        bookingWindowObservedAt: updated.bookingWindowObservedAt
      }
    };
  }
  if (command.action === "alias") return createCourseProfileSlugAlias(command.courseId, command.slug, command.apply);
  const input = command.file ? await readFile(command.file, "utf8") : await readStdin(stdin);
  return applyCourseProfileDraft(JSON.parse(input) as unknown, command.apply);
}

function readStdin(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    let input = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { input += chunk; });
    stream.on("end", () => resolve(input));
    stream.on("error", reject);
  });
}

async function main() {
  const result = await executeCourseProfileCommand(parseCourseProfileCommand(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "Course profile command failed"); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
