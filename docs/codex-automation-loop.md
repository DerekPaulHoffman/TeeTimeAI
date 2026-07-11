# Codex Automation Loop

Tee Time Spot uses Postgres as the queue of user demand, durable per-search Vercel Workflows for operational checks, and a local Codex automation only for product improvement.

## Cadence

- Per search: create/edit/resume/manual-check starts an immediate durable workflow; the workflow sleeps until its own `nextCheckAt` between checks.
- Daily recovery: query only for overdue or failed workflow schedules and restart those searches; do not fetch course availability when the recovery queue is empty.
- Hourly: run one complete autonomous improvement cycle: inspect evidence, select one candidate, implement it, verify it, commit it, push it, deploy live-impacting work, verify production, and record what was learned.
- Baseline UI/access check: run `npm run ui:smoke` locally, or set `UI_SMOKE_BASE_URL=https://teetimespot.com` before `npm run ui:smoke` for production.
- Before deploys: run `npm run test:run`, `npm run lint`, `npm run build`, and `npm run ui:smoke`.

## Loop Engineering Standard

The loop should improve the product every time it has credible evidence to act. It should not just rerun the same prompt.

- Start each run by writing or confirming checkpoints: `queue_confirmed`, `candidate_selected`, `tool_research_done`, `ui_smoke_done`, `verification_done`, `git_committed`, `git_pushed`, `production_verified`, and `outcome_recorded`.
- Run `npm run automation:inspect` and `npm run ui:smoke` before choosing a candidate unless a provider outage makes the smoke impossible. A smoke failure is evidence, not noise.
- Treat `AutomationRun.notes`, `WebsiteEvent`, `WebsiteFeedback`, recent browser discoveries, probe history, and deployment notes as a living learning ledger. Each loop should record what went right, what went wrong, what assumption changed, and the next concrete action.
- Repeated work must decay. If the same course, tool, provider, or UI issue has been inspected repeatedly with no new evidence, mark it stale or blocked and rotate to a different evidence-backed candidate.
- A loop that has no fresh queue blocker, smoke failure, provider drift, new research finding, or learnable adapter should return `no_op` instead of inventing polish work.
- Use normalized terminal outcomes: `success`, `no_op`, `incident`, `needs_adapter`, `blocked_policy`, `blocked_auth`, `blocked_tooling`, `blocked_env`, `blocked_dirty_worktree`, `blocked_git`, `blocked_concurrent`, and `needs_human`.
- Keep side effects idempotent. Email alerts, GitHub pushes, and future Slack/GitHub comments need stable keys so a retry cannot duplicate them.
- Use a per-loop lease before mutating shared state so concurrent runs do not work the same candidate.
- Stop cleanly when blocked. Record the blocker and next concrete unblock step instead of exploring indefinitely.

## Tool And Design Escalation

Every improvement run must actively look for better tools when the current approach is not producing a good product.

- Run a short current-tool research pass for UI, automation, maps/search, email, or scraping gaps before picking a new approach.
- Research must be decision-grade: cite the current source or product observed, state the decision it changes, and ship or record one concrete next action. Do not keep repeating generic research.
- For weak UI or UX, compare against current tee-time/waitlist products and AI design tools, then choose one concrete change to ship.
- Use the browser for desktop and mobile smokes on onboarding, course ranking, dashboard state, and email preview.
- The committed Playwright smoke checks desktop and mobile onboarding, typed-location discovery, course ranking limit enforcement, dashboard access/setup states, failed same-origin requests, browser console/page errors, horizontal overflow, and too-small interactive controls.
- If email preview is missing or inaccessible, record that as a UI/product gap and either add a preview route or explain why another issue is higher leverage.
- If the implemented UI still looks weak after a browser smoke, escalate to a stronger design workflow: Figma/Figma Make, v0, a generated design direction, or another current tool discovered during the research pass.
- Do not blindly adopt generated output. Treat design tools as idea generators, then implement the best parts in the repo's Next.js app with tests and build verification.

## Operational Authority

The hourly improvement loop has broad authority to get Tee Time Spot working end to end.

- It may create and configure project accounts, apps, projects, API keys, deploy targets, OAuth settings, webhooks, DNS records, and integrations needed for Tee Time Spot.
- This includes, when useful, Vercel, Neon, Clerk, Google Cloud/Places, Resend, Figma/Figma Make, v0, GitHub repo settings, monitoring tools, and replacement tools discovered during the research pass.
- It may update repo code, environment examples, setup docs, GitHub branches, deployment configuration, database schema, seed data, and automation scripts.
- It may use already-authenticated browser sessions and CLI auth for project setup work.
- It must keep secrets out of git. Store credentials only in approved local env files, provider dashboards, GitHub/Vercel environment variables, or the appropriate secret manager.
- It must record created/updated accounts, projects, keys, callback URLs, webhooks, and deploy targets in `AutomationRun.notes` or docs with secret values redacted.
- It must prefer free tiers or already-approved plans. Paid upgrades, payment methods, legal commitments, production data deletion, ownership transfer, or domain purchases require a fresh explicit user approval.
- If a service blocks setup with identity, billing, phone verification, captcha, or unavailable credentials, stop with `blocked_auth`, `blocked_env`, or `needs_human` and record the exact unblock step.

## Git And Production Handoff

The hourly loop is authorized to commit, push, and deploy its own verified work. A successful code or configuration improvement is not complete until its source-control and production handoff is complete.

- Run the recurring automation from an isolated automation checkout or Codex-managed worktree, not from the interactive workspace at `C:\dev\TeeTimeAI`. For manual local automation runs, use the dedicated checkout at `C:\dev\TeeTimeAI-automation`.
- Start every run with `npm run automation:preflight`. The preflight fetches `origin`, accepts either `main` or a clean detached Codex-managed worktree, fast-forwards clean checkouts that are only behind, and returns `blocked_dirty_worktree` or `blocked_git` before the expensive loop starts.
- Preflight is dependency-free so it can run before `npm install` in a fresh worktree. After the gate passes, install lockfile-declared dependencies when `node_modules` is absent.
- Keep ignored local operator configuration available to future Codex-managed worktrees through `.worktreeinclude`; never commit the copied secret/config files themselves.
- Start by confirming the checkout is clean and its `HEAD` is not ahead of or diverged from `origin/main`. A detached worktree is expected when `main` is already checked out in the interactive workspace.
- When the tree is clean and `HEAD` is only behind, update it with a fast-forward-only merge of `origin/main` before selecting work.
- If unrelated or unexplained changes already exist, do not stage, commit, overwrite, revert, or deploy them. Stop with `blocked_dirty_worktree` and identify the paths.
- Keep each run to one coherent improvement and stage only its intended files. Never use `git add -A` without first proving every changed path belongs to the run.
- Do not commit until focused tests, `npm run test:run`, `npm run lint`, `npm run build`, `npm run ui:smoke`, and `git diff --check` pass for a code change.
- Create a clear imperative or Conventional Commit, record its SHA, and use the push command reported by preflight: `git push origin main` on `main`, or `git push origin HEAD:main` from a detached automation worktree. If the push is rejected or the remote moved, stop with `blocked_git`; do not force-push or rewrite history.
- For an additive, backward-compatible Prisma migration, run production migration status/deploy with the Vercel production environment before the app deployment. Destructive migrations, irreversible data changes, or broad backfills require fresh user approval.
- Deploy with `npx vercel --prod --yes` when the commit affects the live app, production workflow, adapter runtime, or provider configuration. Docs-only and local-operator-only changes still require a commit and push but not a Vercel deployment.
- After deployment, require `Ready`, the `teetimespot.com` and `www.teetimespot.com` aliases, production UI smoke, key route/API checks, recent error-log inspection, and confirmation that the deployed behavior corresponds to the pushed commit.
- If production verification fails because of the new release, stop further improvement work and report `incident`. Prefer a safe rollback to the previous verified deployment only when no incompatible migration or irreversible state change is involved; otherwise require human intervention.
- A `no_op` run must not edit repo files, create a commit, push, deploy, or append repetitive deployment notes.

## Boundaries

- Alert only. Do not book, hold, pay, enter checkout, bypass controls, solve verification flows, or use account-specific course sessions.
- Respect policy blockers. If a course prohibits automated retrieval, mark it `BLOCKED` and record a `BLOCKED_POLICY` probe.
- Keep observations per course. A failed course probe must not hide successful probes for other ranked courses.
- Only email newly seen matching slots. Alert suppression dedupes by search, course, and source id so source-local times and stored UTC times cannot trigger duplicate emails.

## Run Contract

Each automation run should:

1. Confirm a clean checkout whose `HEAD` is synchronized with `origin/main`, and record the starting SHA and preflight push command.
2. Create an `AutomationRun` row with a prompt version.
3. Load active `TeeSearch` rows and ranked `CoursePreference` rows.
4. Load current evidence from `WebsiteEvent`, `WebsiteFeedback`, recent learning signals, `CourseAutomationDiscovery`, current probes, smoke evidence, deployment notes, and recent Vercel logs.
5. Select one evidence-backed candidate, preferring production incidents, real-user blockers, alert failures, adapter gaps, funnel regressions, repeated feedback, and verified UI/access failures in that order.
6. Evaluate `Course.automationEligibility` and `policyNotes` before fetching.
7. Use the matching adapter only when `detectedPlatform` and `bookingMetadata` are known.
8. Run a current-tool/design research pass only when it can change the selected implementation strategy.
9. Implement one coherent improvement with focused tests and documentation where behavior changed.
10. Record `CourseProbe` rows for `NO_MATCH`, `MATCH_FOUND`, `NEEDS_ADAPTER`, `FETCH_FAILED`, and blockers when worker behavior is explicitly verified.
11. Upsert `TeeTimeMatch` rows and send Resend alerts only through the normal idempotent worker path.
12. Run focused verification plus `npm run test:run`, `npm run lint`, `npm run build`, `npm run ui:smoke`, and `git diff --check`.
13. Inspect the final diff, stage only intended files, create one coherent commit, and run the push command reported by preflight without force.
14. Apply only safe additive production migrations, then deploy live-impacting work to Vercel.
15. Verify the production deployment, aliases, routes/APIs, desktop/mobile smoke, logs, and expected behavior.
16. Confirm the working tree is clean and checked-out `HEAD` matches `origin/main` after the push.
17. Finish the `AutomationRun` and automation memory with outcome, evidence, checkpoints, commit SHA, deployment ID, changed files, verification, learning signals, changed assumptions, and blockers. Do not write a repo note for `no_op`.

## UI Smoke Contract

The hourly loop should treat UI/access problems as product bugs. The smoke must pass before `ui_smoke_done` is true.

```powershell
npm run ui:smoke
```

For production verification after a deploy:

```powershell
$env:UI_SMOKE_BASE_URL = "https://teetimespot.com"
npm run ui:smoke
Remove-Item Env:\UI_SMOKE_BASE_URL
```

The smoke intentionally fails when course discovery returns too few courses to exercise the five-course limit. That points to a provider/configuration problem or a degraded demo mode, both of which the hourly loop should surface.

## First Adapter

The initial supported adapter is ForeUP, seeded by:

```powershell
npm run seed:foreup
```

This creates Tashua Knolls and H. Smith Richardson course records with the known public tee-sheet metadata from the earlier local monitor.
