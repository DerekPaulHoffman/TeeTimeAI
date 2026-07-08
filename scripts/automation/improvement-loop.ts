import { finishAutomationRun, startAutomationRun } from "@/lib/automation/db-service";

const PROMPT_VERSION = "tee-time-ai-improvement-loop-v2";

const loopPrompt = `
You are improving TeeTimeAI, a Next.js + Postgres tee-time alert POC.

Every run:
1. Read recent AutomationRun, CourseProbe, and TeeTimeMatch rows.
2. Identify the highest-leverage improvement from actual failures or UX friction.
3. Confirm checkpoints: queue_confirmed, candidate_selected, tool_research_done, ui_smoke_done, verification_done, outcome_recorded.
4. If the issue is adapter-related, add or refine one course-platform adapter without entering checkout, payment, login, or verification-code flows.
5. If the issue is UI-related, use the browser to test onboarding, course ranking, dashboard state, and email preview on desktop and mobile.
6. If the UI does not look good, do not settle. Run current research for better design tooling and try a stronger workflow such as Figma/Figma Make, v0, a generated design direction, or another current tool discovered during research.
7. Use generated design output as input, not truth. Implement the best parts in the Next.js app and preserve the product boundaries.
8. Run unit tests, lint, build/type checks, and a browser smoke.
9. Record outcome, checkpoints, changed files, research links, and blockers in AutomationRun.

Tool research requirements:
- Look up current official docs or product pages before adopting a new design/automation tool.
- Compare at least two options when the current approach is weak.
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
  await finishAutomationRun(run.id, {
    outcome: "needs_codex_session",
    notes: loopPrompt.trim()
  });
  console.log(loopPrompt.trim());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
