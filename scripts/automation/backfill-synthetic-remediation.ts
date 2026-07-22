import "./load-local-env";

import { pathToFileURL } from "node:url";

import { prisma } from "@/lib/prisma";
import {
  selectSyntheticRemediationCandidates,
  summarizeSyntheticRemediationCoverage,
  type SyntheticRemediationSearch
} from "@/lib/automation/synthetic-remediation";
import { reportCourseSupportIssue } from "@/lib/automation/support-incidents";

type BackfillOptions = {
  emailTag: string;
  apply: boolean;
};

export async function backfillSyntheticRemediation(options: BackfillOptions) {
  validateEmailTag(options.emailTag);

  const searches = await prisma.teeSearch.findMany({
    where: {
      syntheticMultiCycle: true,
      user: { email: { contains: options.emailTag, mode: "insensitive" } }
    },
    select: {
      id: true,
      preferences: {
        select: {
          course: {
            select: {
              id: true,
              name: true,
              timeZone: true,
              detectedPlatform: true,
              detectedBookingUrl: true,
              website: true
            }
          }
        }
      },
      probes: {
        select: {
          courseId: true,
          outcome: true,
          observedAt: true,
          message: true
        }
      }
    }
  });

  const candidates = selectSyntheticRemediationCandidates(
    searches satisfies SyntheticRemediationSearch[]
  );
  const coverage = summarizeSyntheticRemediationCoverage(searches);
  const byKind = Object.fromEntries(
    ["NEEDS_ADAPTER", "FETCH_FAILED"].map((kind) => [
      kind,
      candidates.filter((candidate) => candidate.kind === kind).length
    ])
  );
  const result = {
    mode: options.apply ? "apply" : "dry-run",
    searches: searches.length,
    selectedPreferences: coverage.selectedPreferences,
    missingOutcomes: coverage.missingOutcomes,
    latestOutcomeCounts: coverage.latestOutcomeCounts,
    actionablePreferences: candidates.reduce(
      (sum, candidate) => sum + candidate.affectedPreferenceCount,
      0
    ),
    distinctCourses: candidates.length,
    byKind,
    incidentStates: {} as Record<string, number>
  };

  if (!options.apply) {
    return result;
  }

  const backfilledAt = new Date();
  for (const candidate of candidates) {
    const state = await reportCourseSupportIssue({
      course: candidate.course,
      searchId: candidate.searchId,
      kind: candidate.kind,
      message: candidate.message,
      nextAction: candidate.nextAction,
      now: backfilledAt
    });
    result.incidentStates[state.status] =
      (result.incidentStates[state.status] ?? 0) + 1;
  }

  return result;
}

function validateEmailTag(emailTag: string) {
  if (!/^\+[a-z0-9][a-z0-9-]{2,80}-$/i.test(emailTag)) {
    throw new Error(
      "--email-tag must be a bounded plus-address local-part tag such as +example-cohort-."
    );
  }
}

function parseArgs(argv: string[]): BackfillOptions {
  const emailTagIndex = argv.indexOf("--email-tag");
  const emailTag = emailTagIndex >= 0 ? argv[emailTagIndex + 1] : undefined;
  if (!emailTag) {
    throw new Error("--email-tag is required.");
  }
  return { emailTag, apply: argv.includes("--apply") };
}

async function main() {
  console.log(
    JSON.stringify(await backfillSyntheticRemediation(parseArgs(process.argv.slice(2))), null, 2)
  );
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
