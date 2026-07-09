import "./load-local-env";

import { finishAutomationRun, startAutomationRun } from "@/lib/automation/db-service";
import {
  buildImprovementCheckpoints,
  type ImprovementCandidateInput,
  selectImprovementCandidate
} from "@/lib/automation/improvement";
import { prisma } from "@/lib/prisma";

const PROMPT_VERSION = "tee-time-spot-improvement-loop-v4";

const loopPrompt = `
You are improving Tee Time Spot, a Next.js + Postgres tee-time alert POC.

Every run:
1. Run \`npm run automation:inspect\` and read recent AutomationRun, CourseProbe, TeeTimeMatch, active TeeSearch, and pending alert state.
2. Run \`npm run ui:smoke\` as a baseline desktop/mobile UI and access check. Treat failures as first-class improvement candidates.
3. Confirm checkpoints: queue_confirmed, candidate_selected, tool_research_done, ui_smoke_done, verification_done, outcome_recorded.
4. Pick the highest-leverage improvement from current evidence. If current actionable probes and pending alerts are empty, default to the strongest UI/accessibility/provider smoke finding.
5. If the issue is adapter-related, add or refine one course-platform adapter without entering checkout, payment, login, or verification-code flows.
6. If the issue is UI-related, inspect the Playwright screenshots/traces and use the browser to test onboarding, course ranking, dashboard state, and email preview or the absence of an email preview route on desktop and mobile.
7. If the UI does not look good or a core flow is inaccessible, do not settle. Run current research for better design/tooling and try a stronger workflow such as Figma/Figma Make, v0, a generated design direction, or another current tool discovered during research.
8. Use generated design output as input, not truth. Implement the best parts in the Next.js app and preserve the product boundaries.
9. If setup/configuration is the blocker, create or update the project accounts, apps, API keys, deploy targets, callback URLs, webhooks, DNS records, and integrations needed to get Tee Time Spot working.
10. For code changes, run focused tests plus \`npm run test:run\`, \`npm run lint\`, \`npm run build\`, and \`npm run ui:smoke\`.
11. For live-impacting changes, deploy to Vercel, then run \`$env:UI_SMOKE_BASE_URL="https://teetimespot.com"; npm run ui:smoke; Remove-Item Env:\\UI_SMOKE_BASE_URL\` and inspect Vercel errors/warnings.
12. Record outcome, checkpoints, changed files, research links, setup changes, UI smoke evidence, screenshot/trace paths when relevant, and blockers in AutomationRun/docs.

UI smoke expectations:
- The smoke must cover desktop and mobile.
- It must flag same-origin failed requests, 4xx/5xx responses, console errors, page errors, horizontal overflow, too-small interactive targets, broken typed-location discovery, broken 1-to-5 course ranking, disabled/enabled save-control mistakes, and unclear dashboard access/setup states.
- If the smoke finds a legitimate product issue, fix it and rerun the smoke instead of marking ui_smoke_done.
- If the smoke is blocked by missing browser binaries, provider env, auth, or network, fix that setup when authorized or stop with blocked_tooling, blocked_env, or blocked_auth and the exact unblock step.

Operational authority:
- You have broad access to make Tee Time Spot work end to end.
- You may create and configure project resources in Vercel, Neon, Clerk, Google Cloud/Places, Resend, Figma/Figma Make, v0, GitHub repo settings, monitoring tools, and replacement tools discovered during research.
- You may use already-authenticated browser sessions and CLI auth for Tee Time Spot project setup.
- You may update code, env examples, docs, database schema, seed data, deployment config, GitHub branches, and automation scripts.
- Never commit secrets. Store credentials only in local env files, provider dashboards, GitHub/Vercel env vars, or the appropriate secret manager.
- Record created/updated accounts, projects, callback URLs, webhooks, deploy targets, and key names with secret values redacted.
- Prefer free tiers or already-approved plans. Paid upgrades, payment methods, legal commitments, production data deletion, ownership transfer, or domain purchases require fresh explicit user approval.
- If a service requires identity, billing, phone verification, captcha, or unavailable credentials, stop with blocked_auth, blocked_env, or needs_human and record the exact unblock step.

Tool research requirements:
- Look up current official docs or product pages before adopting a new design/automation tool.
- Compare at least two options when the current approach is weak or the UI smoke keeps finding the same class of issue.
- Prefer tools that can produce code or concrete design artifacts the repo can verify.

Loop engineering requirements:
- Use stable idempotency keys for notifications and external side effects.
- Use a per-loop lease before mutating shared candidates when more than one automation could run.
- Stop with a normalized terminal outcome: success, no_op, needs_adapter, blocked_policy, blocked_auth, blocked_tooling, blocked_env, or needs_human.

Hard boundaries:
- Alert only; never book, hold, pay, bypass controls, or solve account-specific course flows.
- Respect terms/policy blockers and mark courses blocked when automation is prohibited.
- Keep per-course observations separate.
- Only alert on newly matching slots.
`;

async function main() {
  const run = await startAutomationRun(PROMPT_VERSION);
  const snapshot = await loadImprovementSnapshot();
  const candidate = selectImprovementCandidate(snapshot);
  const checkpoints = buildImprovementCheckpoints({
    queueConfirmed: true,
    candidateSelected: candidate.kind !== "empty_queue",
    outcomeRecorded: true
  });

  await finishAutomationRun(run.id, {
    outcome: candidate.outcome,
    notes: JSON.stringify(
      {
        checkpoints,
        candidate,
        snapshot: {
          activeSearchCount: snapshot.activeSearchCount,
          pendingAlertCount: snapshot.pendingAlerts.length,
          actionableProbeCount: snapshot.actionableProbes.length
        },
        nextPrompt: loopPrompt.trim()
      },
      null,
      2
    )
  });
  console.warn(
    JSON.stringify(
      {
        automationRunId: run.id,
        outcome: candidate.outcome,
        checkpoints,
        candidate
      },
      null,
      2
    )
  );
}

async function loadImprovementSnapshot(): Promise<ImprovementCandidateInput> {
  const recentSince = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [activeSearchCount, pendingAlerts, probes] = await Promise.all([
    prisma.teeSearch.count({
      where: {
        status: "ACTIVE",
        date: {
          gte: today
        }
      }
    }),
    prisma.teeTimeMatch.findMany({
      where: {
        alertStatus: "PENDING",
        teeSearch: {
          status: "ACTIVE"
        }
      },
      orderBy: {
        firstSeenAt: "asc"
      },
      take: 10,
      include: {
        course: true
      }
    }),
    prisma.courseProbe.findMany({
      where: {
        observedAt: {
          gte: recentSince
        },
        outcome: {
          in: [
            "BLOCKED_POLICY",
            "BLOCKED_AUTH",
            "BLOCKED_TOOLING",
            "FETCH_FAILED",
            "NEEDS_ADAPTER"
          ]
        }
      },
      orderBy: {
        observedAt: "desc"
      },
      take: 25,
      include: {
        course: true
      }
    })
  ]);

  return {
    activeSearchCount,
    pendingAlerts: pendingAlerts.map((alert) => ({
      id: alert.id,
      courseName: alert.course.name,
      firstSeenAt: alert.firstSeenAt.toISOString()
    })),
    actionableProbes: latestProbePerCourseSearch(probes).flatMap((probe) => {
      const outcome = probe.outcome;
      if (!isActionableProbeOutcome(outcome)) {
        return [];
      }

      return [
        {
          id: probe.id,
          outcome,
          courseName: probe.course.name,
          platform: probe.course.detectedPlatform,
          observedAt: probe.observedAt.toISOString(),
          message: probe.message
        }
      ];
    })
  };
}

function isActionableProbeOutcome(
  outcome: string
): outcome is ImprovementCandidateInput["actionableProbes"][number]["outcome"] {
  return (
    outcome === "BLOCKED_POLICY" ||
    outcome === "BLOCKED_AUTH" ||
    outcome === "BLOCKED_TOOLING" ||
    outcome === "FETCH_FAILED" ||
    outcome === "NEEDS_ADAPTER"
  );
}

function latestProbePerCourseSearch<
  T extends {
    teeSearchId: string;
    courseId: string;
  }
>(probes: T[]) {
  const latest = new Map<string, T>();

  for (const probe of probes) {
    const key = `${probe.teeSearchId}:${probe.courseId}`;
    if (!latest.has(key)) {
      latest.set(key, probe);
    }
  }

  return [...latest.values()];
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
