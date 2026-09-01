import "./load-local-env";

import { pathToFileURL } from "node:url";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  invalidateReviewDerivedIdentityFinal,
  recordCourseMonitoringFinalClassification,
} from "@/lib/automation/course-monitoring";
import type {
  GooglePlaceAccessOverrideValue,
  GooglePlaceReviewRecord,
} from "@/lib/places/google-place-reviews";

const ACCESS_OVERRIDES = new Set<GooglePlaceAccessOverrideValue>([
  "VERIFIED_PUBLIC",
  "VERIFIED_PRIVATE",
  "VERIFIED_NON_COURSE",
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
  "--longitude",
]);

const FLAG_OPTIONS = new Set([
  "--apply",
  "--inactive",
  "--retain-when-canonical-absent",
]);

export type GooglePlaceReviewUpsert = Omit<
  GooglePlaceReviewRecord,
  "reviewedAt"
> & {
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
    }
  | {
      mode: "not-reconciled";
      action: "upsert" | "deactivate";
      googlePlaceId: string;
      reason:
        | "course_final_source_rejected"
        | "course_mapping_changed"
        | "review_version_conflict";
    };

type GooglePlaceReviewPersistenceSnapshot = GooglePlaceReviewUpsert & {
  id: string;
  updatedAt: Date;
};

type GooglePlaceReviewNotReconciledReason = Extract<
  GooglePlaceReviewCommandResult,
  { mode: "not-reconciled" }
>["reason"];

class GooglePlaceReviewNotReconciledError extends Error {
  constructor(readonly reason: GooglePlaceReviewNotReconciledReason) {
    super(`Google Place review was not reconciled: ${reason}`);
    this.name = "GooglePlaceReviewNotReconciledError";
  }
}

export function parseGooglePlaceReviewCommand(
  args: readonly string[],
): ParsedGooglePlaceReviewCommand {
  if (args[0] !== "upsert") {
    throw new Error('Expected the "upsert" command');
  }

  const { values, flags } = parseOptions(args.slice(1));
  const googlePlaceId = requiredValue(values, "--place-id");
  const apply = flags.has("--apply");

  if (flags.has("--inactive")) {
    const metadataOptions = [...values.keys()].filter(
      (option) => option !== "--place-id",
    );
    if (
      metadataOptions.length > 0 ||
      flags.has("--retain-when-canonical-absent")
    ) {
      throw new Error("--inactive accepts only --place-id and --apply");
    }

    return { action: "deactivate", apply, googlePlaceId };
  }

  const accessOverride = optionalAccessOverride(
    values.get("--access-override"),
  );
  const name = requiredValue(values, "--name");
  const classification = requiredValue(values, "--classification");
  const evidenceUrl = parseHttpUrl(
    requiredValue(values, "--evidence-url"),
    "--evidence-url",
  );
  const reviewedAt = parseReviewDate(requiredValue(values, "--reviewed-at"));
  const canonicalPlaceId = optionalValue(values.get("--canonical-place-id"));
  const canonicalName = optionalValue(values.get("--canonical-name"));
  const canonicalAddress = optionalValue(values.get("--canonical-address"));
  const canonicalWebsiteUrl = values.has("--canonical-website-url")
    ? parseHttpUrl(
        requiredValue(values, "--canonical-website-url"),
        "--canonical-website-url",
      )
    : null;
  const canonicalPhone = optionalValue(values.get("--canonical-phone"));
  const latitude = optionalCoordinate(
    values.get("--latitude"),
    "latitude",
    -90,
    90,
  );
  const longitude = optionalCoordinate(
    values.get("--longitude"),
    "longitude",
    -180,
    180,
  );
  const retainWhenCanonicalAbsent = flags.has("--retain-when-canonical-absent");

  if ((latitude === null) !== (longitude === null)) {
    throw new Error("--latitude and --longitude must be provided together");
  }
  if (accessOverride === "VERIFIED_PUBLIC" && latitude === null) {
    throw new Error(
      "VERIFIED_PUBLIC reviews require --latitude and --longitude",
    );
  }

  const hasCanonicalIdentity = [
    canonicalName,
    canonicalAddress,
    canonicalWebsiteUrl,
    canonicalPhone,
  ].some((value) => value !== null);
  if (hasCanonicalIdentity && !canonicalPlaceId) {
    throw new Error("Canonical identity fields require --canonical-place-id");
  }
  if (
    retainWhenCanonicalAbsent &&
    (!canonicalPlaceId || canonicalPlaceId === googlePlaceId)
  ) {
    throw new Error(
      "--retain-when-canonical-absent requires a different --canonical-place-id",
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
      retainWhenCanonicalAbsent,
    },
  };
}

export async function executeGooglePlaceReviewCommand(
  command: ParsedGooglePlaceReviewCommand,
): Promise<GooglePlaceReviewCommandResult> {
  if (!command.apply) {
    return command.action === "upsert"
      ? { mode: "dry-run", action: "upsert", review: command.review }
      : {
          mode: "dry-run",
          action: "deactivate",
          googlePlaceId: command.googlePlaceId,
        };
  }

  if (command.action === "deactivate") {
    const existing = await readGooglePlaceReviewSnapshot(
      prisma,
      command.googlePlaceId,
    );
    if (!existing) {
      throw new Error(
        `No Google Place review found for ${command.googlePlaceId}`,
      );
    }

    const mappedCourse = isActiveIdentityFinalReview(existing)
      ? await prisma.course.findUnique({
          where: { googlePlaceId: command.googlePlaceId },
          select: { id: true },
        })
      : null;
    if (mappedCourse) {
      try {
        const reconciliation = await invalidateReviewDerivedIdentityFinal({
          courseId: mappedCourse.id,
          expectedReview: {
            observedAt: existing.reviewedAt,
            policyNotes: identityFinalPolicyNotes(existing),
          },
          correction: { kind: "DEACTIVATED" },
          onReviewAccepted: async (transaction) => {
            await assertCourseMapping(
              transaction,
              mappedCourse.id,
              command.googlePlaceId,
            );
            await deactivateExactGooglePlaceReview(transaction, existing);
          },
        });
        if (!reconciliation.reviewAccepted) {
          return notReconciledResult(
            "deactivate",
            command.googlePlaceId,
            "course_mapping_changed",
          );
        }
        return {
          mode: "applied",
          action: "deactivate",
          googlePlaceId: command.googlePlaceId,
          ...(reconciliation.finalInvalidated
            ? { reconciledCourseIds: [mappedCourse.id] }
            : {}),
        };
      } catch (error) {
        if (error instanceof GooglePlaceReviewNotReconciledError) {
          return notReconciledResult(
            "deactivate",
            command.googlePlaceId,
            error.reason,
          );
        }
        throw error;
      }
    }

    try {
      await prisma.$transaction((transaction) =>
        deactivateExactGooglePlaceReview(transaction, existing),
      );
    } catch (error) {
      if (error instanceof GooglePlaceReviewNotReconciledError) {
        return notReconciledResult(
          "deactivate",
          command.googlePlaceId,
          error.reason,
        );
      }
      throw error;
    }

    return {
      mode: "applied",
      action: "deactivate",
      googlePlaceId: command.googlePlaceId,
    };
  }

  const { googlePlaceId } = command.review;

  if (command.review.accessOverride === "VERIFIED_PUBLIC") {
    const existing = await readGooglePlaceReviewSnapshot(prisma, googlePlaceId);
    const mappedCourse =
      existing &&
      isActiveIdentityFinalReview(existing) &&
      command.review.reviewedAt.getTime() > existing.reviewedAt.getTime()
        ? await prisma.course.findUnique({
            where: { googlePlaceId },
            select: { id: true },
          })
        : null;
    if (existing && mappedCourse) {
      try {
        const reconciliation = await invalidateReviewDerivedIdentityFinal({
          courseId: mappedCourse.id,
          expectedReview: {
            observedAt: existing.reviewedAt,
            policyNotes: identityFinalPolicyNotes(existing),
          },
          correction: {
            kind: "VERIFIED_PUBLIC",
            observedAt: command.review.reviewedAt,
            policyNotes: verifiedPublicPolicyNotes(command.review),
          },
          onReviewAccepted: async (transaction) => {
            await assertCourseMapping(
              transaction,
              mappedCourse.id,
              googlePlaceId,
            );
            await persistCurrentGooglePlaceReview(
              transaction,
              command.review,
            );
          },
        });
        if (!reconciliation.reviewAccepted) {
          return notReconciledResult(
            "upsert",
            googlePlaceId,
            "course_mapping_changed",
          );
        }
        return {
          mode: "applied",
          action: "upsert",
          googlePlaceId,
          ...(reconciliation.finalInvalidated
            ? { reconciledCourseIds: [mappedCourse.id] }
            : {}),
        };
      } catch (error) {
        if (error instanceof GooglePlaceReviewNotReconciledError) {
          return notReconciledResult("upsert", googlePlaceId, error.reason);
        }
        throw error;
      }
    }
  }

  if (
    command.review.accessOverride === "VERIFIED_NON_COURSE" ||
    command.review.accessOverride === "VERIFIED_PRIVATE"
  ) {
    const course = await prisma.course.findUnique({
      where: { googlePlaceId },
      select: { id: true, name: true },
    });
    if (course) {
      const reviewKind =
        command.review.accessOverride === "VERIFIED_PRIVATE"
          ? "private course listing"
          : "non-course listing";
      try {
        const classification =
          await recordCourseMonitoringFinalClassification({
            courseId: course.id,
            state: "FINAL_IDENTITY",
            outcome: "IDENTITY_FINAL",
            evidence: {
              kind: "COURSE_INTELLIGENCE",
              observedAt: command.review.reviewedAt,
            },
            source: "MAINTENANCE",
            message: `${course.name} was verified as a ${reviewKind} (${command.review.classification}).`,
            evidenceUrl: command.review.evidenceUrl,
            courseIntelligenceUpdate: {
              isPublic: false,
              automationEligibility: "BLOCKED",
              automationReason: "OTHER",
              policyNotes: identityFinalPolicyNotes(command.review),
              intelligenceVerifiedAt: command.review.reviewedAt,
              intelligenceConfidence: 1,
            },
            onSourceAccepted: async (transaction, evidenceObservedAt) => {
              if (
                evidenceObservedAt.getTime() !==
                command.review.reviewedAt.getTime()
              ) {
                throw new GooglePlaceReviewNotReconciledError(
                  "review_version_conflict",
                );
              }
              await assertCourseMapping(transaction, course.id, googlePlaceId);
              await persistCurrentGooglePlaceReview(
                transaction,
                command.review,
              );
            },
          });
        if (!classification?.sourceEvidenceAccepted) {
          return {
            mode: "not-reconciled",
            action: "upsert",
            googlePlaceId,
            reason: "course_final_source_rejected",
          };
        }
        return {
          mode: "applied",
          action: "upsert",
          googlePlaceId,
          reconciledCourseIds: [course.id],
        };
      } catch (error) {
        if (error instanceof GooglePlaceReviewNotReconciledError) {
          return {
            mode: "not-reconciled",
            action: "upsert",
            googlePlaceId,
            reason: error.reason,
          };
        }
        throw error;
      }
    }
  }

  try {
    await prisma.$transaction((transaction) =>
      persistCurrentGooglePlaceReview(transaction, command.review),
    );
    return { mode: "applied", action: "upsert", googlePlaceId };
  } catch (error) {
    if (error instanceof GooglePlaceReviewNotReconciledError) {
      return {
        mode: "not-reconciled",
        action: "upsert",
        googlePlaceId,
        reason: error.reason,
      };
    }
    throw error;
  }
}

async function persistCurrentGooglePlaceReview(
  transaction: Prisma.TransactionClient,
  review: GooglePlaceReviewUpsert,
) {
  const existing = await transaction.googlePlaceReview.findUnique({
    where: { googlePlaceId: review.googlePlaceId },
    select: {
      id: true,
      googlePlaceId: true,
      accessOverride: true,
      name: true,
      classification: true,
      evidenceUrl: true,
      reviewedAt: true,
      active: true,
      canonicalPlaceId: true,
      canonicalName: true,
      canonicalAddress: true,
      canonicalWebsiteUrl: true,
      canonicalPhone: true,
      latitude: true,
      longitude: true,
      retainWhenCanonicalAbsent: true,
      updatedAt: true,
    },
  });
  if (!existing) {
    try {
      await transaction.googlePlaceReview.create({ data: review });
      return;
    } catch (error) {
      if (isPrismaUniqueConstraintError(error)) {
        throw new GooglePlaceReviewNotReconciledError(
          "review_version_conflict",
        );
      }
      throw error;
    }
  }

  if (existing.reviewedAt.getTime() > review.reviewedAt.getTime()) {
    throw new GooglePlaceReviewNotReconciledError("review_version_conflict");
  }
  if (existing.reviewedAt.getTime() === review.reviewedAt.getTime()) {
    if (haveSameGooglePlaceReviewFacts(existing, review)) {
      return;
    }
    throw new GooglePlaceReviewNotReconciledError("review_version_conflict");
  }

  const updated = await transaction.googlePlaceReview.updateMany({
    where: googlePlaceReviewSnapshotWhere(existing),
    data: {
      accessOverride: review.accessOverride,
      name: review.name,
      classification: review.classification,
      evidenceUrl: review.evidenceUrl,
      reviewedAt: review.reviewedAt,
      active: review.active,
      canonicalPlaceId: review.canonicalPlaceId,
      canonicalName: review.canonicalName,
      canonicalAddress: review.canonicalAddress,
      canonicalWebsiteUrl: review.canonicalWebsiteUrl,
      canonicalPhone: review.canonicalPhone,
      latitude: review.latitude,
      longitude: review.longitude,
      retainWhenCanonicalAbsent: review.retainWhenCanonicalAbsent,
    },
  });
  if (updated.count !== 1) {
    throw new GooglePlaceReviewNotReconciledError("review_version_conflict");
  }
}

async function readGooglePlaceReviewSnapshot(
  transaction: Pick<Prisma.TransactionClient, "googlePlaceReview">,
  googlePlaceId: string,
) {
  return transaction.googlePlaceReview.findUnique({
    where: { googlePlaceId },
    select: {
      id: true,
      googlePlaceId: true,
      accessOverride: true,
      name: true,
      classification: true,
      evidenceUrl: true,
      reviewedAt: true,
      active: true,
      canonicalPlaceId: true,
      canonicalName: true,
      canonicalAddress: true,
      canonicalWebsiteUrl: true,
      canonicalPhone: true,
      latitude: true,
      longitude: true,
      retainWhenCanonicalAbsent: true,
      updatedAt: true,
    },
  });
}

function isActiveIdentityFinalReview(review: GooglePlaceReviewUpsert) {
  return (
    review.active &&
    (review.accessOverride === "VERIFIED_PRIVATE" ||
      review.accessOverride === "VERIFIED_NON_COURSE")
  );
}

function identityFinalPolicyNotes(review: GooglePlaceReviewUpsert) {
  const reviewKind =
    review.accessOverride === "VERIFIED_PRIVATE"
      ? "private course listing"
      : "non-course listing";
  return `Verified ${reviewKind} Google Place review: ${review.classification}. Evidence: ${review.evidenceUrl}`;
}

function verifiedPublicPolicyNotes(review: GooglePlaceReviewUpsert) {
  return `Verified public course listing Google Place review: ${review.classification}. Evidence: ${review.evidenceUrl}`;
}

async function assertCourseMapping(
  transaction: Prisma.TransactionClient,
  courseId: string,
  googlePlaceId: string,
) {
  const mappedCourse = await transaction.course.findUnique({
    where: { id: courseId },
    select: { googlePlaceId: true },
  });
  if (mappedCourse?.googlePlaceId !== googlePlaceId) {
    throw new GooglePlaceReviewNotReconciledError("course_mapping_changed");
  }
}

async function deactivateExactGooglePlaceReview(
  transaction: Prisma.TransactionClient,
  review: GooglePlaceReviewPersistenceSnapshot,
) {
  const updated = await transaction.googlePlaceReview.updateMany({
    where: googlePlaceReviewSnapshotWhere(review),
    data: { active: false },
  });
  if (updated.count !== 1) {
    throw new GooglePlaceReviewNotReconciledError("review_version_conflict");
  }
}

function notReconciledResult(
  action: "upsert" | "deactivate",
  googlePlaceId: string,
  reason: GooglePlaceReviewNotReconciledReason,
): GooglePlaceReviewCommandResult {
  return { mode: "not-reconciled", action, googlePlaceId, reason };
}

function googlePlaceReviewSnapshotWhere(
  review: GooglePlaceReviewPersistenceSnapshot,
) {
  return {
    id: review.id,
    googlePlaceId: review.googlePlaceId,
    accessOverride: review.accessOverride,
    name: review.name,
    classification: review.classification,
    evidenceUrl: review.evidenceUrl,
    reviewedAt: review.reviewedAt,
    active: review.active,
    canonicalPlaceId: review.canonicalPlaceId,
    canonicalName: review.canonicalName,
    canonicalAddress: review.canonicalAddress,
    canonicalWebsiteUrl: review.canonicalWebsiteUrl,
    canonicalPhone: review.canonicalPhone,
    latitude: review.latitude,
    longitude: review.longitude,
    retainWhenCanonicalAbsent: review.retainWhenCanonicalAbsent,
    updatedAt: review.updatedAt,
  };
}

function haveSameGooglePlaceReviewFacts(
  left: GooglePlaceReviewUpsert,
  right: GooglePlaceReviewUpsert,
) {
  return (
    left.googlePlaceId === right.googlePlaceId &&
    left.accessOverride === right.accessOverride &&
    left.name === right.name &&
    left.classification === right.classification &&
    left.evidenceUrl === right.evidenceUrl &&
    left.reviewedAt.getTime() === right.reviewedAt.getTime() &&
    left.active === right.active &&
    left.canonicalPlaceId === right.canonicalPlaceId &&
    left.canonicalName === right.canonicalName &&
    left.canonicalAddress === right.canonicalAddress &&
    left.canonicalWebsiteUrl === right.canonicalWebsiteUrl &&
    left.canonicalPhone === right.canonicalPhone &&
    left.latitude === right.latitude &&
    left.longitude === right.longitude &&
    left.retainWhenCanonicalAbsent === right.retainWhenCanonicalAbsent
  );
}

function isPrismaUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
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
  value: string | undefined,
): GooglePlaceAccessOverrideValue | null {
  if (!value) {
    return null;
  }
  if (!ACCESS_OVERRIDES.has(value as GooglePlaceAccessOverrideValue)) {
    throw new Error(
      `--access-override must be one of ${[...ACCESS_OVERRIDES].join(", ")}`,
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

  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `${option} must be an http(s) URL without embedded credentials`,
    );
  }
  return url.toString();
}

function parseReviewDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("--reviewed-at must use YYYY-MM-DD");
  }

  const reviewedAt = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(reviewedAt.getTime()) ||
    reviewedAt.toISOString().slice(0, 10) !== value
  ) {
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
  maximum: number,
) {
  if (value === undefined) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`--${label} requires a numeric value`);
  }

  const coordinate = Number(normalized);
  if (
    !Number.isFinite(coordinate) ||
    coordinate < minimum ||
    coordinate > maximum
  ) {
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
    "Dry-run is the default. Add --apply to write to Postgres.",
  ].join("\n");
}

export async function runGooglePlaceReviewCli(
  args: readonly string[],
  writeOutput: (output: string) => void = console.log,
) {
  if (args.includes("--help")) {
    writeOutput(usage());
    return 0;
  }

  const command = parseGooglePlaceReviewCommand(args);
  const result = await executeGooglePlaceReviewCommand(command);
  writeOutput(JSON.stringify(result, null, 2));
  return result.mode === "not-reconciled" ? 1 : 0;
}

async function main() {
  const exitCode = await runGooglePlaceReviewCli(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main()
    .catch((error) => {
      console.error(
        error instanceof Error
          ? error.message
          : "Google Place review command failed",
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
