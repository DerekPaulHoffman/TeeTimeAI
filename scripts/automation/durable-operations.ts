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
  policyNotes: z.string().trim().min(10).max(2000),
  confidence: z.number().min(0).max(1)
});

export function parseCourseEvidence(value: unknown) {
  return courseEvidenceSchema.parse(value);
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
    select: { id: true, updatedAt: true }
  });
  if (!course) throw new Error("No course matched the supplied Google Place ID.");

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
          bookingMetadata:
            (input.bookingMetadata as Prisma.InputJsonValue | undefined) ??
            Prisma.DbNull,
          policyNotes: input.policyNotes,
          intelligenceVerifiedAt: new Date(),
          intelligenceConfidence: input.confidence
        }
      });
      if (updated.count !== 1) {
        throw new Error("Course evidence changed while the update was being applied.");
      }
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
          apiMetadata:
            (input.bookingMetadata as Prisma.InputJsonValue | undefined) ??
            Prisma.DbNull,
          confidence: input.confidence,
          evidence: { learnedFrom: "validated-operator-course-evidence" }
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
