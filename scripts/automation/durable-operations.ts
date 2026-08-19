import "./load-local-env";

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  AutomationEligibility,
  AutomationReason,
  BookingAccessMode,
  BookingMethod,
  DetectedPlatform,
  Prisma
} from "@prisma/client";
import { z } from "zod";

import {
  classifyAutomationRunKind,
  parseAutomationRunAudit
} from "@/lib/automation/db-service";
import { revalidateCourseMonitoringForProviderEvidenceChangeInTransaction } from "@/lib/automation/course-monitoring";
import { COURSE_PROVIDER_EXECUTION_EVIDENCE_FIELDS } from "@/lib/automation/course-provider-execution-evidence";
import { sanitizeResponderText } from "@/lib/automation/course-support-responder-policy";
import { getOperatorCourseEvidenceReviewAt } from "@/lib/automation/operator-evidence-lifecycle";
import { bootstrapAutomationWorkers } from "@/lib/automation/worker-state";
import { prisma } from "@/lib/prisma";

const httpUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    !/^(?:localhost|127\.|0\.0\.0\.0$|\[?::1\]?$)/i.test(url.hostname);
}, "Expected a credential-free HTTP(S) URL");

const courseEvidenceSchema = z.object({
  googlePlaceId: z.string().trim().min(3).max(250),
  sourceUrl: httpUrl,
  bookingUrl: httpUrl,
  apiEndpoint: httpUrl.optional(),
  detectedPlatform: z.nativeEnum(DetectedPlatform),
  providerFamilyKey: z.string().trim().min(2).max(80),
  bookingMethod: z.nativeEnum(BookingMethod),
  bookingAccessMode: z.nativeEnum(BookingAccessMode).default("PUBLIC_SIGNED_OUT"),
  automationEligibility: z.nativeEnum(AutomationEligibility),
  automationReason: z.nativeEnum(AutomationReason).default("NONE"),
  bookingMetadata: z.record(z.string(), z.unknown()).optional(),
  clearBookingMetadata: z.literal(true).optional(),
  policyNotes: z.string().trim().min(10).max(2000),
  confidence: z.number().min(0).max(1)
}).superRefine((input, context) => {
  if (input.bookingMetadata !== undefined && input.clearBookingMetadata) {
    context.addIssue({
      code: "custom",
      message: "Choose bookingMetadata replacement or clearBookingMetadata, not both."
    });
  }
});

export function parseCourseEvidence(value: unknown) {
  return courseEvidenceSchema.parse(value);
}

type ParsedCourseEvidence = z.infer<typeof courseEvidenceSchema>;

export function getCourseEvidenceBookingMetadataUpdate(
  input: Pick<ParsedCourseEvidence, "bookingMetadata" | "clearBookingMetadata">
) {
  if (input.bookingMetadata !== undefined) {
    return {
      bookingMetadata: input.bookingMetadata as Prisma.InputJsonValue
    };
  }
  if (input.clearBookingMetadata) {
    return { bookingMetadata: Prisma.DbNull };
  }
  return {};
}

export function getCourseEvidenceDiscoveryBookingMetadata(
  input: Pick<ParsedCourseEvidence, "bookingMetadata" | "clearBookingMetadata">,
  currentBookingMetadata: Prisma.JsonValue | null
) {
  if (input.bookingMetadata !== undefined) {
    return input.bookingMetadata as Prisma.InputJsonValue;
  }
  if (input.clearBookingMetadata || currentBookingMetadata === null) {
    return Prisma.DbNull;
  }
  return currentBookingMetadata as Prisma.InputJsonValue;
}

export function getCourseEvidencePolicyNoteHistory(
  priorPolicyNotes: string | null,
  acceptedPolicyNotes: string
) {
  return {
    priorPolicyNotes: priorPolicyNotes
      ? sanitizeResponderText(priorPolicyNotes).trim().slice(0, 1_000)
      : null,
    acceptedPolicyNotes:
      sanitizeResponderText(acceptedPolicyNotes).trim().slice(0, 1_000)
  };
}

export function assertSafeCourseEvidenceMetadataTransition(
  course: Pick<
    Prisma.CourseGetPayload<{
      select: typeof COURSE_EVIDENCE_MATERIAL_SNAPSHOT_SELECT;
    }>,
    | "bookingMetadata"
    | "detectedPlatform"
    | "providerFamilyKey"
    | "bookingMethod"
    | "detectedBookingUrl"
  >,
  input: Pick<
    ParsedCourseEvidence,
    | "bookingMetadata"
    | "clearBookingMetadata"
    | "detectedPlatform"
    | "providerFamilyKey"
    | "bookingMethod"
    | "bookingUrl"
  >
) {
  if (
    course.bookingMetadata !== null &&
    input.bookingMetadata === undefined &&
    !input.clearBookingMetadata &&
    (
      course.detectedPlatform !== input.detectedPlatform ||
      course.providerFamilyKey !== input.providerFamilyKey ||
      course.bookingMethod !== input.bookingMethod ||
      course.detectedBookingUrl !== input.bookingUrl
    )
  ) {
    throw new Error(
      "Provider identity changed while booking metadata was omitted; replace or explicitly clear it."
    );
  }
}

export const COURSE_EVIDENCE_MATERIAL_SNAPSHOT_SELECT = {
  id: true,
  updatedAt: true,
  timeZone: true,
  website: true,
  detectedBookingUrl: true,
  detectedPlatform: true,
  providerFamilyKey: true,
  bookingMethod: true,
  bookingWindowDaysAhead: true,
  bookingWindowEvidenceUrl: true,
  bookingReleaseTimeLocal: true,
  bookingWindowSource: true,
  bookingWindowConfidence: true,
  automationEligibility: true,
  automationReason: true,
  monitoringMode: true,
  bookingAccessMode: true,
  policyNotes: true,
  isPublic: true,
  intelligenceConfidence: true,
  bookingMetadata: true,
  layoutHoleCounts: true,
  layoutHolesVerifiedAt: true
} as const satisfies Prisma.CourseSelect;

if (
  COURSE_PROVIDER_EXECUTION_EVIDENCE_FIELDS.some(
    (field) => !(field in COURSE_EVIDENCE_MATERIAL_SNAPSHOT_SELECT)
  )
) {
  throw new Error("The operator evidence snapshot omits a material provider execution field.");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const apply = args.includes("--apply");
  if (command === "bootstrap-workers") {
    return write(await bootstrapAutomationWorkers({ apply }));
  }
  if (command === "backfill-audits") {
    return write(await backfillAutomationAudits(apply));
  }
  if (command === "reconcile-policy-blocks") {
    return write(await reconcilePolicyOnlyBlocks(apply));
  }
  if (command === "upsert-course-evidence") {
    return write(await upsertCourseEvidence(args, apply));
  }
  throw new Error(
    "Use bootstrap-workers, backfill-audits, reconcile-policy-blocks, or upsert-course-evidence."
  );
}

export async function backfillAutomationAudits(apply = false) {
  const runs = await prisma.automationRun.findMany({
    where: {
      OR: [{ audit: { equals: Prisma.DbNull } }, { kind: "OTHER" }]
    },
    select: {
      id: true,
      promptVersion: true,
      completedAt: true,
      outcome: true,
      notes: true
    },
    orderBy: [{ startedAt: "asc" }, { id: "asc" }]
  });
  const prepared = runs.map((run) => ({
    ...run,
    kind: classifyAutomationRunKind(run.promptVersion),
    audit: parseAutomationRunAudit(run.notes)
  }));
  const requiredUnparseable = prepared.filter(
    (run) =>
      requiresStructuredAutomationAudit(run.promptVersion) &&
      !run.audit
  ).length;
  if (apply && requiredUnparseable > 0) {
    throw new Error(
      "Refusing audit backfill because an improvement run has unparseable required audit data."
    );
  }

  if (apply) {
    for (const run of prepared) {
      await prisma.automationRun.update({
        where: { id: run.id },
        data: {
          kind: run.kind,
          status: run.completedAt
            ? run.outcome === "failed" || run.outcome?.startsWith("blocked_")
              ? "FAILED"
              : "COMPLETED"
            : "RUNNING",
          auditSchemaVersion: run.audit ? 1 : null,
          audit: run.audit ?? Prisma.DbNull
        }
      });
    }
  }

  return {
    mode: apply ? "apply" : "dry_run",
    considered: prepared.length,
    parseableAudits: prepared.filter((run) => run.audit).length,
    unparseableAudits: prepared.filter((run) => !run.audit).length,
    requiredUnparseable
  };
}

export function requiresStructuredAutomationAudit(promptVersion: string) {
  const improvementVersion = promptVersion.match(/improvement-loop-v(\d+)/)?.[1];
  if (improvementVersion && Number(improvementVersion) >= 9) {
    return true;
  }
  const hourlyVersion = promptVersion.match(/hourly-improvement-v(\d+)/)?.[1];
  return Boolean(hourlyVersion && Number(hourlyVersion) >= 7);
}

export async function reconcilePolicyOnlyBlocks(apply = false) {
  const courses = await prisma.course.findMany({
    where: {
      automationEligibility: "BLOCKED",
      automationReason: "AUTOMATION_PROHIBITED"
    },
    select: {
      id: true,
      website: true,
      detectedBookingUrl: true,
      detectedPlatform: true,
      bookingMethod: true,
      bookingAccessMode: true,
      policyNotes: true
    },
    orderBy: { id: "asc" }
  });
  const actionable = courses.filter(
    (course) => course.website || course.detectedBookingUrl
  );
  const ambiguous = courses.length - actionable.length;
  if (apply && ambiguous > 0) {
    throw new Error(
      "Refusing policy reconciliation because at least one course lacks a safe source URL."
    );
  }

  if (apply) {
    for (const course of actionable) {
      const sourceUrl = course.website ?? course.detectedBookingUrl!;
      await prisma.$transaction([
        prisma.course.update({
          where: { id: course.id },
          data: {
            automationEligibility: "NEEDS_REVIEW",
            intelligenceReviewAt: new Date()
          }
        }),
        prisma.courseAutomationDiscovery.create({
          data: {
            courseId: course.id,
            status: "INSPECTED",
            detectedPlatform: course.detectedPlatform,
            bookingMethod: course.bookingMethod,
            bookingAccessMode: course.bookingAccessMode,
            automationEligibility: "NEEDS_REVIEW",
            automationReason: "AUTOMATION_PROHIBITED",
            sourceUrl,
            bookingUrl: course.detectedBookingUrl,
            confidence: 0.5,
            evidence: {
              learnedFrom: "legacy-policy-reconciliation",
              policyRetained: Boolean(course.policyNotes)
            }
          }
        })
      ]);
    }
  }

  return {
    mode: apply ? "apply" : "dry_run",
    considered: courses.length,
    actionable: actionable.length,
    ambiguous
  };
}

async function upsertCourseEvidence(args: string[], apply: boolean) {
  const file = readOption(args, "--file");
  const raw = file ? await readFile(file, "utf8") : await readStdin();
  const input = parseCourseEvidence(JSON.parse(raw) as unknown);
  const course = await prisma.course.findUnique({
    where: { googlePlaceId: input.googlePlaceId },
    select: COURSE_EVIDENCE_MATERIAL_SNAPSHOT_SELECT
  });
  if (!course) throw new Error("No course matched the supplied Google Place ID.");
  assertSafeCourseEvidenceMetadataTransition(course, input);
  const observedAt = new Date();
  const reviewAt = getOperatorCourseEvidenceReviewAt(observedAt);

  if (apply) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.course.updateMany({
        where: { id: course.id, updatedAt: course.updatedAt },
        data: {
          detectedPlatform: input.detectedPlatform,
          providerFamilyKey: input.providerFamilyKey,
          bookingMethod: input.bookingMethod,
          bookingAccessMode: input.bookingAccessMode,
          automationEligibility: input.automationEligibility,
          automationReason: input.automationReason,
          detectedBookingUrl: input.bookingUrl,
          ...getCourseEvidenceBookingMetadataUpdate(input),
          policyNotes: input.policyNotes,
          intelligenceVerifiedAt: observedAt,
          intelligenceReviewAt: reviewAt,
          intelligenceConfidence: input.confidence
        }
      });
      if (updated.count !== 1) {
        throw new Error("Course evidence changed while the update was being applied.");
      }
      const applied = await tx.course.findUnique({
        where: { id: course.id }
      });
      if (!applied) {
        throw new Error("Course evidence disappeared while the update was being applied.");
      }
      await revalidateCourseMonitoringForProviderEvidenceChangeInTransaction(tx, {
        courseId: course.id,
        before: course,
        after: applied,
        source: "OPERATOR_CLI",
        now: observedAt
      });
      await tx.courseAutomationDiscovery.create({
        data: {
          courseId: course.id,
          status: input.automationEligibility === "ALLOWED" ? "LEARNED" : "INSPECTED",
          detectedPlatform: input.detectedPlatform,
          bookingMethod: input.bookingMethod,
          bookingAccessMode: input.bookingAccessMode,
          automationEligibility: input.automationEligibility,
          automationReason: input.automationReason,
          sourceUrl: input.sourceUrl,
          bookingUrl: input.bookingUrl,
          apiEndpoint: input.apiEndpoint,
          apiMetadata: getCourseEvidenceDiscoveryBookingMetadata(
            input,
            course.bookingMetadata
          ),
          confidence: input.confidence,
          evidence: {
            learnedFrom: "validated-operator-course-evidence",
            bookingMetadataDisposition:
              input.bookingMetadata !== undefined
                ? "REPLACED"
                : input.clearBookingMetadata
                  ? "CLEARED"
                  : "PRESERVED",
            ...getCourseEvidencePolicyNoteHistory(
              course.policyNotes,
              input.policyNotes
            ),
            reviewAt: reviewAt.toISOString()
          }
        }
      });
    });
  }

  return {
    mode: apply ? "apply" : "dry_run",
    matched: 1,
    platform: input.detectedPlatform,
    metadataReady: Boolean(input.bookingMetadata)
  };
}

function readOption(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1]?.trim() : undefined;
}

async function readStdin() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

function write(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch(() => {
      console.error(JSON.stringify({ ok: false, error: "DURABLE_OPERATIONS_COMMAND_FAILED" }));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
