import "./load-local-env";

import { pathToFileURL } from "node:url";

import { prisma } from "@/lib/prisma";
import { resolveCourseSupportIncident } from "@/lib/automation/support-incidents";
import type {
  GooglePlaceAccessOverrideValue,
  GooglePlaceReviewRecord
} from "@/lib/places/google-place-reviews";

const ACCESS_OVERRIDES = new Set<GooglePlaceAccessOverrideValue>([
  "VERIFIED_PUBLIC",
  "VERIFIED_PRIVATE",
  "VERIFIED_NON_COURSE"
]);

const VALUE_OPTIONS = new Set([
  "--place-id",
  "--access-override",
  "--name",
  "--classification",
  "--evidence-url",
  "--reviewed-at",
  "--canonical-place-id",
  "--canonical-name",
  "--canonical-address",
  "--canonical-website-url",
  "--canonical-phone",
  "--latitude",
  "--longitude"
]);

const FLAG_OPTIONS = new Set([
  "--apply",
  "--inactive",
  "--retain-when-canonical-absent"
]);

export type GooglePlaceReviewUpsert = Omit<GooglePlaceReviewRecord, "reviewedAt"> & {
  reviewedAt: Date;
};

export type ParsedGooglePlaceReviewCommand =
  | {
      action: "upsert";
      apply: boolean;
      review: GooglePlaceReviewUpsert;
    }
  | {
      action: "deactivate";
      apply: boolean;
      googlePlaceId: string;
    };

export type GooglePlaceReviewCommandResult =
  | {
      mode: "dry-run";
      action: "upsert";
      review: GooglePlaceReviewUpsert;
    }
  | {
      mode: "dry-run";
      action: "deactivate";
      googlePlaceId: string;
    }
  | {
      mode: "applied";
      action: "upsert" | "deactivate";
      googlePlaceId: string;
      reconciledCourseIds?: string[];
    };

export function parseGooglePlaceReviewCommand(
  args: readonly string[]
): ParsedGooglePlaceReviewCommand {
  if (args[0] !== "upsert") {
    throw new Error('Expected the "upsert" command');
  }

  const { values, flags } = parseOptions(args.slice(1));
  const googlePlaceId = requiredValue(values, "--place-id");
  const apply = flags.has("--apply");

  if (flags.has("--inactive")) {
    const metadataOptions = [...values.keys()].filter((option) => option !== "--place-id");
    if (metadataOptions.length > 0 || flags.has("--retain-when-canonical-absent")) {
      throw new Error("--inactive accepts only --place-id and --apply");
    }

    return { action: "deactivate", apply, googlePlaceId };
  }

  const accessOverride = optionalAccessOverride(values.get("--access-override"));
  const name = requiredValue(values, "--name");
  const classification = requiredValue(values, "--classification");
  const evidenceUrl = parseHttpUrl(requiredValue(values, "--evidence-url"), "--evidence-url");
  const reviewedAt = parseReviewDate(requiredValue(values, "--reviewed-at"));
  const canonicalPlaceId = optionalValue(values.get("--canonical-place-id"));
  const canonicalName = optionalValue(values.get("--canonical-name"));
  const canonicalAddress = optionalValue(values.get("--canonical-address"));
  const canonicalWebsiteUrl = values.has("--canonical-website-url")
    ? parseHttpUrl(
        requiredValue(values, "--canonical-website-url"),
        "--canonical-website-url"
      )
    : null;
  const canonicalPhone = optionalValue(values.get("--canonical-phone"));
  const latitude = optionalCoordinate(values.get("--latitude"), "latitude", -90, 90);
  const longitude = optionalCoordinate(values.get("--longitude"), "longitude", -180, 180);
  const retainWhenCanonicalAbsent = flags.has("--retain-when-canonical-absent");

  if ((latitude === null) !== (longitude === null)) {
    throw new Error("--latitude and --longitude must be provided together");
  }
  if (accessOverride === "VERIFIED_PUBLIC" && latitude === null) {
    throw new Error("VERIFIED_PUBLIC reviews require --latitude and --longitude");
  }

  const hasCanonicalIdentity = [
    canonicalName,
    canonicalAddress,
    canonicalWebsiteUrl,
    canonicalPhone
  ].some((value) => value !== null);
  if (hasCanonicalIdentity && !canonicalPlaceId) {
    throw new Error("Canonical identity fields require --canonical-place-id");
  }
  if (
    retainWhenCanonicalAbsent &&
    (!canonicalPlaceId || canonicalPlaceId === googlePlaceId)
  ) {
    throw new Error(
      "--retain-when-canonical-absent requires a different --canonical-place-id"
    );
  }

  return {
    action: "upsert",
    apply,
    review: {
      googlePlaceId,
      accessOverride,
      name,
      classification,
      evidenceUrl,
      reviewedAt,
      active: true,
      canonicalPlaceId,
      canonicalName,
      canonicalAddress,
      canonicalWebsiteUrl,
      canonicalPhone,
      latitude,
      longitude,
      retainWhenCanonicalAbsent
    }
  };
}

export async function executeGooglePlaceReviewCommand(
  command: ParsedGooglePlaceReviewCommand
): Promise<GooglePlaceReviewCommandResult> {
  if (!command.apply) {
    return command.action === "upsert"
      ? { mode: "dry-run", action: "upsert", review: command.review }
      : {
          mode: "dry-run",
          action: "deactivate",
          googlePlaceId: command.googlePlaceId
        };
  }

  if (command.action === "deactivate") {
    const result = await prisma.googlePlaceReview.updateMany({
      where: { googlePlaceId: command.googlePlaceId },
      data: { active: false }
    });
    if (result.count === 0) {
      throw new Error(`No Google Place review found for ${command.googlePlaceId}`);
    }

    return {
      mode: "applied",
      action: "deactivate",
      googlePlaceId: command.googlePlaceId
    };
  }

  const { googlePlaceId, ...reviewData } = command.review;
  await prisma.googlePlaceReview.upsert({
    where: { googlePlaceId },
    create: command.review,
    update: reviewData
  });

  if (command.review.accessOverride === "VERIFIED_NON_COURSE") {
    const course = await prisma.course.findUnique({
      where: { googlePlaceId },
      select: { id: true, name: true }
    });
    if (course) {
      await prisma.course.update({
        where: { id: course.id },
        data: {
          isPublic: false,
          automationEligibility: "BLOCKED",
          automationReason: "OTHER",
          policyNotes: `Verified non-course Google Place review: ${command.review.classification}. Evidence: ${command.review.evidenceUrl}`,
          intelligenceVerifiedAt: command.review.reviewedAt,
          intelligenceConfidence: 1
        }
      });
      await resolveCourseSupportIncident({
        courseId: course.id,
        resolution: "DIRECT_BOOKING_CLASSIFIED",
        message: `${course.name} was verified as a non-course listing (${command.review.classification}).`
      });
      return {
        mode: "applied",
        action: "upsert",
        googlePlaceId,
        reconciledCourseIds: [course.id]
      };
    }
  }

  return { mode: "applied", action: "upsert", googlePlaceId };
}

function parseOptions(args: readonly string[]) {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (FLAG_OPTIONS.has(option)) {
      if (flags.has(option)) {
        throw new Error(`Duplicate option ${option}`);
      }
      flags.add(option);
      continue;
    }
    if (!VALUE_OPTIONS.has(option)) {
      throw new Error(`Unknown option ${option}`);
    }
    if (values.has(option)) {
      throw new Error(`Duplicate option ${option}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    values.set(option, value);
    index += 1;
  }

  return { values, flags };
}

function requiredValue(values: ReadonlyMap<string, string>, option: string) {
  const value = optionalValue(values.get(option));
  if (!value) {
    throw new Error(`${option} is required`);
  }
  return value;
}

function optionalValue(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function optionalAccessOverride(
  value: string | undefined
): GooglePlaceAccessOverrideValue | null {
  if (!value) {
    return null;
  }
  if (!ACCESS_OVERRIDES.has(value as GooglePlaceAccessOverrideValue)) {
    throw new Error(
      `--access-override must be one of ${[...ACCESS_OVERRIDES].join(", ")}`
    );
  }
  return value as GooglePlaceAccessOverrideValue;
}

function parseHttpUrl(value: string, option: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${option} must be a valid URL`);
  }

  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error(`${option} must be an http(s) URL without embedded credentials`);
  }
  return url.toString();
}

function parseReviewDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("--reviewed-at must use YYYY-MM-DD");
  }

  const reviewedAt = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(reviewedAt.getTime()) || reviewedAt.toISOString().slice(0, 10) !== value) {
    throw new Error("--reviewed-at must be a valid calendar date");
  }
  if (reviewedAt.getTime() > Date.now()) {
    throw new Error("--reviewed-at cannot be in the future");
  }
  return reviewedAt;
}

function optionalCoordinate(
  value: string | undefined,
  label: "latitude" | "longitude",
  minimum: number,
  maximum: number
) {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`--${label} requires a numeric value`);
  }

  const coordinate = Number(normalized);
  if (!Number.isFinite(coordinate) || coordinate < minimum || coordinate > maximum) {
    throw new Error(`--${label} must be between ${minimum} and ${maximum}`);
  }
  return coordinate;
}

function usage() {
  return [
    "Usage:",
    "  npm run automation:place-review -- upsert --place-id <id> --name <name> --classification <classification> --evidence-url <url> --reviewed-at <YYYY-MM-DD> [options] [--apply]",
    "  npm run automation:place-review -- upsert --place-id <id> --inactive [--apply]",
    "",
    "Dry-run is the default. Add --apply to write to Postgres."
  ].join("\n");
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(usage());
    return;
  }

  const command = parseGooglePlaceReviewCommand(process.argv.slice(2));
  const result = await executeGooglePlaceReviewCommand(command);
  console.log(JSON.stringify(result, null, 2));
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Google Place review command failed");
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
