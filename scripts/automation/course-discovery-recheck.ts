import "./load-local-env";

import { pathToFileURL } from "node:url";

import type { Prisma } from "@prisma/client";

import { runParkedCourseCampaignCommand } from "@/lib/automation/course-support-campaign";
import { finishAutomationRun, startAutomationRun } from "@/lib/automation/db-service";
import {
  KNOWN_PROVIDER_FAMILIES,
  SOURCE_CONFLICT_PROVIDER_FAMILY,
  SOURCE_MISSING_PROVIDER_FAMILY
} from "@/lib/automation/provider-capabilities";
import { prepareCourseSupportVerificationMonitoring } from "@/lib/automation/search-monitoring-discovery";
import { prisma } from "@/lib/prisma";

const PROMPT_VERSION = "tee-time-spot-course-support-discovery-recheck-v1";
const MAX_COURSES = 10;

type RecheckTarget = {
  id: string;
  name: string;
  website: string | null;
  supportIncident: {
    id: string;
    cycle: number;
    revision: number;
    status: "AUTO_INVESTIGATING" | "NEEDS_HUMAN" | "RESOLVED";
    activeBatchId: string | null;
  } | null;
};

type RecheckSnapshot = {
  detectedPlatform: string;
  providerFamilyKey: string;
  bookingMethod: string;
  automationEligibility: string;
  automationReason: string;
  bookingAccessMode: string;
  supportIncident: {
    status: string;
    activeBatchId: string | null;
  } | null;
  monitoringStatus: { state: string } | null;
};

type DiscoveryRecheckDependencies = {
  loadTargets: (courseNames: readonly string[]) => Promise<RecheckTarget[]>;
  recheck: (target: RecheckTarget) => Promise<{
    attemptedCourseIds: string[];
    appliedCourseIds: string[];
    failedCourseIds: string[];
    deferredCourseIds: string[];
  }>;
  loadSnapshot: (courseId: string) => Promise<RecheckSnapshot | null>;
  startRun: () => Promise<{ id: string }>;
  finishRun: (
    id: string,
    input: { outcome: string; errors?: Prisma.InputJsonValue; notes: string }
  ) => Promise<unknown>;
  runParkedCohort?: typeof runParkedCourseCampaignCommand;
};

export type CourseDiscoveryRecheckOptions =
  | {
      apply: boolean;
      courseNames: string[];
      parkedCohort?: false;
    }
  | {
      apply: boolean;
      courseNames: [];
      parkedCohort: true;
      expectCount: number;
      expectDigest?: string | null;
    };

export type CourseDiscoveryRecheckResult = {
  mode: "apply" | "dry-run";
  requestedCount: number;
  readyCount: number;
  outcomes: Array<{
    ordinal: number;
    outcome:
      | "READY"
      | "ACTIVE_OWNER"
      | "ALREADY_RESOLVED"
      | "SOURCE_UNAVAILABLE"
      | "EVIDENCE_APPLIED"
      | "EVIDENCE_RECORDED"
      | "PROVIDER_BUSY"
      | "FETCH_FAILED"
      | "NO_ACTION";
    detectedPlatform?: string;
    providerFamilyKey?: string;
    bookingMethod?: string;
    automationEligibility?: string;
    automationReason?: string;
    bookingAccessMode?: string;
    monitoringState?: string | null;
    incidentStatus?: string | null;
  }>;
};

export async function runCourseDiscoveryRecheck(
  options: CourseDiscoveryRecheckOptions,
  dependencies: DiscoveryRecheckDependencies = defaultDependencies
): Promise<
  CourseDiscoveryRecheckResult | Awaited<ReturnType<typeof runParkedCourseCampaignCommand>>
> {
  if (options.parkedCohort) {
    const runner = dependencies.runParkedCohort ?? runParkedCourseCampaignCommand;
    return runner({
      apply: options.apply,
      expectedCount: options.expectCount,
      expectedDigest: options.expectDigest
    });
  }
  const courseNames = normalizeCourseNames(options.courseNames);
  const loadedTargets = await dependencies.loadTargets(courseNames);
  const targets = orderTargets(courseNames, loadedTargets);
  const readiness = targets.map(getTargetReadiness);
  const readyCount = readiness.filter((item) => item === "READY").length;

  if (!options.apply) {
    return {
      mode: "dry-run",
      requestedCount: targets.length,
      readyCount,
      outcomes: readiness.map((outcome, index) => ({
        ordinal: index + 1,
        outcome
      }))
    };
  }

  const run = await dependencies.startRun();
  const outcomes: CourseDiscoveryRecheckResult["outcomes"] = [];
  const failedOrdinals: number[] = [];

  for (const [index, target] of targets.entries()) {
    const ordinal = index + 1;
    const ready = readiness[index];
    if (ready !== "READY") {
      outcomes.push({ ordinal, outcome: ready });
      continue;
    }

    try {
      const recheck = await dependencies.recheck(target);
      const snapshot = await dependencies.loadSnapshot(target.id);
      const outcome = snapshot?.supportIncident?.activeBatchId
        ? "ACTIVE_OWNER"
        : snapshot?.supportIncident?.status === "RESOLVED"
          ? "ALREADY_RESOLVED"
          : recheck.appliedCourseIds.includes(target.id)
            ? "EVIDENCE_APPLIED"
            : recheck.failedCourseIds.includes(target.id)
              ? "FETCH_FAILED"
              : recheck.deferredCourseIds.includes(target.id)
                ? "PROVIDER_BUSY"
                : recheck.attemptedCourseIds.includes(target.id)
                  ? "EVIDENCE_RECORDED"
                  : "NO_ACTION";
      if (outcome === "FETCH_FAILED") {
        failedOrdinals.push(ordinal);
      }
      outcomes.push({ ordinal, outcome, ...sanitizeSnapshot(snapshot) });
    } catch {
      failedOrdinals.push(ordinal);
      outcomes.push({ ordinal, outcome: "FETCH_FAILED" });
    }
  }

  const result: CourseDiscoveryRecheckResult = {
    mode: "apply",
    requestedCount: targets.length,
    readyCount,
    outcomes
  };
  const notes = JSON.stringify(result);
  await dependencies.finishRun(run.id, {
    outcome: failedOrdinals.length === 0 ? "completed" : "completed_with_findings",
    ...(failedOrdinals.length > 0 ? { errors: { failedOrdinals } } : {}),
    notes
  });
  return result;
}

export function parseCourseDiscoveryRecheckArgs(argv: readonly string[]) {
  const courseNames: string[] = [];
  let parkedCohort = false;
  let expectCount: number | null = null;
  let expectDigest: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      continue;
    }
    if (argument === "--parked-cohort") {
      parkedCohort = true;
      continue;
    }
    if (argument === "--expect-count") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--") || !/^\d+$/u.test(value)) {
        throw new Error("--expect-count requires a positive integer.");
      }
      expectCount = Number(value);
      index += 1;
      continue;
    }
    if (argument === "--expect-digest") {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith("--")) {
        throw new Error("--expect-digest requires a value.");
      }
      expectDigest = value;
      index += 1;
      continue;
    }
    if (argument !== "--course-name") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      throw new Error("--course-name requires a value.");
    }
    courseNames.push(value);
    index += 1;
  }
  if (parkedCohort) {
    if (courseNames.length > 0) {
      throw new Error("--parked-cohort cannot be combined with --course-name.");
    }
    if (expectCount === null) {
      throw new Error("--parked-cohort requires --expect-count.");
    }
    return {
      apply: argv.includes("--apply"),
      courseNames: [] as [],
      parkedCohort: true as const,
      expectCount,
      ...(expectDigest ? { expectDigest } : {})
    };
  }
  if (expectCount !== null || expectDigest !== null) {
    throw new Error("--expect-count and --expect-digest require --parked-cohort.");
  }
  return { apply: argv.includes("--apply"), courseNames };
}

function normalizeCourseNames(courseNames: readonly string[]) {
  const normalized = courseNames.map((name) => name.trim()).filter(Boolean);
  if (normalized.length === 0) {
    throw new Error("At least one --course-name is required.");
  }
  if (normalized.length > MAX_COURSES) {
    throw new Error(`At most ${MAX_COURSES} courses may be rechecked at once.`);
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Course names must be unique.");
  }
  return normalized;
}

function orderTargets(courseNames: readonly string[], loadedTargets: readonly RecheckTarget[]) {
  const targetsByName = new Map<string, RecheckTarget[]>();
  for (const target of loadedTargets) {
    const matches = targetsByName.get(target.name) ?? [];
    matches.push(target);
    targetsByName.set(target.name, matches);
  }
  return courseNames.map((courseName) => {
    const matches = targetsByName.get(courseName) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? "A requested course was not found."
          : "A requested course name was ambiguous."
      );
    }
    return matches[0];
  });
}

function getTargetReadiness(target: RecheckTarget) {
  if (!target.website) return "SOURCE_UNAVAILABLE" as const;
  if (!target.supportIncident || target.supportIncident.status === "RESOLVED") {
    return "ALREADY_RESOLVED" as const;
  }
  if (target.supportIncident.activeBatchId) return "ACTIVE_OWNER" as const;
  return "READY" as const;
}

function sanitizeSnapshot(snapshot: RecheckSnapshot | null) {
  if (!snapshot) return {};
  return {
    detectedPlatform: snapshot.detectedPlatform,
    providerFamilyKey: sanitizeProviderFamilyKey(snapshot.providerFamilyKey),
    bookingMethod: snapshot.bookingMethod,
    automationEligibility: snapshot.automationEligibility,
    automationReason: snapshot.automationReason,
    bookingAccessMode: snapshot.bookingAccessMode,
    monitoringState: snapshot.monitoringStatus?.state ?? null,
    incidentStatus: snapshot.supportIncident?.status ?? null
  };
}

function sanitizeProviderFamilyKey(value: string) {
  const normalized = value.trim().toUpperCase();
  return KNOWN_PROVIDER_FAMILIES.includes(normalized as (typeof KNOWN_PROVIDER_FAMILIES)[number]) ||
    normalized === SOURCE_MISSING_PROVIDER_FAMILY ||
    normalized === SOURCE_CONFLICT_PROVIDER_FAMILY
    ? normalized
    : "CUSTOM";
}

const defaultDependencies: DiscoveryRecheckDependencies = {
  loadTargets: (courseNames) =>
    prisma.course.findMany({
      where: { name: { in: [...courseNames] } },
      select: {
        id: true,
        name: true,
        website: true,
        supportIncident: {
          select: {
            id: true,
            cycle: true,
            revision: true,
            status: true,
            activeBatchId: true
          }
        }
      }
    }),
  recheck: (target) =>
    prepareCourseSupportVerificationMonitoring(target.id, undefined, new Date(), {
      forceFresh: true,
      expectedUnownedIncident: {
        id: target.supportIncident!.id,
        cycle: target.supportIncident!.cycle,
        revision: target.supportIncident!.revision,
        status: target.supportIncident!.status
      }
    }),
  loadSnapshot: (courseId) =>
    prisma.course.findUnique({
      where: { id: courseId },
      select: {
        detectedPlatform: true,
        providerFamilyKey: true,
        bookingMethod: true,
        automationEligibility: true,
        automationReason: true,
        bookingAccessMode: true,
        supportIncident: { select: { status: true, activeBatchId: true } },
        monitoringStatus: { select: { state: true } }
      }
    }),
  startRun: () => startAutomationRun(PROMPT_VERSION),
  finishRun: (id, input) =>
    finishAutomationRun(id, {
      outcome: input.outcome,
      ...(input.errors ? { errors: input.errors } : {}),
      notes: input.notes
    }),
  runParkedCohort: runParkedCourseCampaignCommand
};

async function main() {
  const result = await runCourseDiscoveryRecheck(
    parseCourseDiscoveryRecheckArgs(process.argv.slice(2))
  );
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
