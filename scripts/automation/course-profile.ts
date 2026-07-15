import "./load-local-env";

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { applyCourseProfileDraft, createCourseProfileSlugAlias, getCourseProfileResearchPacket, listCourseProfileQueue } from "@/lib/course-profiles/service";
import { validateCourseProfileDraft } from "@/lib/course-profiles/validation";
import { prisma } from "@/lib/prisma";
import { connecticutCourseProfileSeeds } from "../data/connecticut-course-profiles";

export function parseCourseProfileCommand(args: readonly string[]) {
  const action = args[0];
  const apply = args.includes("--apply");
  const value = (option: string) => {
    const index = args.indexOf(option);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (action === "queue") return { action, limit: Number(value("--limit") ?? 3) } as const;
  if (action === "cohort") return { action } as const;
  if (action === "validate-seeds") return { action } as const;
  if (action === "backfill-connecticut") {
    const county = value("--county");
    return { action, apply, ...(county ? { county } : {}) } as const;
  }
  if (action === "research") {
    const courseId = value("--course-id");
    if (!courseId) throw new Error("research requires --course-id");
    return { action, courseId } as const;
  }
  if (action === "alias") {
    const courseId = value("--course-id");
    const slug = value("--slug");
    if (!courseId || !slug) throw new Error("alias requires --course-id and --slug");
    return { action, courseId, slug, apply } as const;
  }
  if (action === "upsert") return { action, apply, file: value("--file") } as const;
  throw new Error('Expected "cohort", "queue", "research", "validate-seeds", "backfill-connecticut", "alias", or "upsert"');
}

export function assertCourseProfileBackfillValid(
  profiles: ReadonlyArray<{ course: string; result: { valid: boolean; errors: string[] } }>
) {
  const invalid = profiles.filter((profile) => !profile.result.valid);
  if (invalid.length > 0) {
    throw new Error(
      `Connecticut backfill preflight failed for ${invalid.length} course${invalid.length === 1 ? "" : "s"}: ${invalid.map((profile) => `${profile.course} (${profile.result.errors.join("; ")})`).join(", ")}`
    );
  }
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
  if (command.action === "alias") return createCourseProfileSlugAlias(command.courseId, command.slug, command.apply);
  if (command.action === "validate-seeds") {
    const profiles = connecticutCourseProfileSeeds.map((seed) => {
      const { googlePlaceId, ...draft } = seed;
      const validation = validateCourseProfileDraft({ ...draft, courseId: `seed:${googlePlaceId}` });
      return { googlePlaceId, valid: validation.valid, errors: validation.errors };
    });
    return {
      count: profiles.length,
      valid: profiles.every((profile) => profile.valid),
      profiles
    };
  }
  if (command.action === "backfill-connecticut") {
    const normalizedCounty = command.county?.toLowerCase().replace(/\s+county$/i, "");
    const selectedSeeds = normalizedCounty
      ? connecticutCourseProfileSeeds.filter(
          (seed) => seed.location.county.toLowerCase() === normalizedCounty
        )
      : connecticutCourseProfileSeeds;
    if (selectedSeeds.length === 0) {
      throw new Error(`No Connecticut profile seeds matched county ${command.county}`);
    }
    if (!normalizedCounty) {
      const currentCohort = await prisma.course.findMany({
        where: {
          automationEligibility: "ALLOWED",
          OR: [{ stateCode: "CT" }, { address: { contains: ", CT" } }]
        },
        select: { googlePlaceId: true, name: true }
      });
      const researchedPlaceIds = new Set(selectedSeeds.map((seed) => seed.googlePlaceId));
      const unresearched = currentCohort.filter(
        (course) => !course.googlePlaceId || !researchedPlaceIds.has(course.googlePlaceId)
      );
      if (unresearched.length > 0) {
        throw new Error(
          `Connecticut ALLOWED cohort has ${unresearched.length} unresearched course records: ${unresearched.map((course) => course.name).join(", ")}`
        );
      }
    }
    const courses = await prisma.course.findMany({
      where: { googlePlaceId: { in: selectedSeeds.map((seed) => seed.googlePlaceId) } },
      select: { id: true, googlePlaceId: true, name: true }
    });
    const coursesByPlaceId = new Map(courses.map((course) => [course.googlePlaceId, course]));
    const missing = selectedSeeds
      .filter((seed) => !coursesByPlaceId.has(seed.googlePlaceId))
      .map((seed) => seed.googlePlaceId);
    if (missing.length > 0) {
      throw new Error(`Connecticut backfill is missing ${missing.length} course records: ${missing.join(", ")}`);
    }

    const preparedDrafts = selectedSeeds.map((seed) => {
      const { googlePlaceId, ...draft } = seed;
      const course = coursesByPlaceId.get(googlePlaceId);
      if (!course) throw new Error(`Course ${googlePlaceId} disappeared after backfill preflight`);
      return { course, draft: { ...draft, courseId: course.id } };
    });
    const dryRunProfiles = [];
    for (const prepared of preparedDrafts) {
      dryRunProfiles.push({
        course: prepared.course.name,
        result: await applyCourseProfileDraft(prepared.draft, false)
      });
    }
    assertCourseProfileBackfillValid(dryRunProfiles);
    if (!command.apply) return { apply: false, count: dryRunProfiles.length, profiles: dryRunProfiles };

    const profiles = [];
    for (const prepared of preparedDrafts) {
      profiles.push({
        course: prepared.course.name,
        result: await applyCourseProfileDraft(prepared.draft, true)
      });
    }
    return { apply: true, count: profiles.length, profiles };
  }
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
