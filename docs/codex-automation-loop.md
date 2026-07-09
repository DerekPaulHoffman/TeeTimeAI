# Codex Automation Loop

Tee Time Spot uses Postgres as the queue of user demand and a local Codex automation as the adaptive worker.

## Cadence

- Every 15 minutes: run `npm run automation:poll` against active searches.
- Hourly: run `npm run automation:improve` to create a Codex-ready prompt from recent failures, adapter gaps, and UI friction.
- Baseline UI/access check: run `npm run ui:smoke` locally, or set `UI_SMOKE_BASE_URL=https://teetimespot.com` before `npm run ui:smoke` for production.
- Before deploys: run `npm run test:run`, `npm run lint`, `npm run build`, and `npm run ui:smoke`.

## Loop Engineering Standard

The loop should improve the product every time it has credible evidence to act. It should not just rerun the same prompt.

- Start each run by writing or confirming checkpoints: `queue_confirmed`, `candidate_selected`, `tool_research_done`, `ui_smoke_done`, `verification_done`, and `outcome_recorded`.
- Run `npm run automation:inspect` and `npm run ui:smoke` before choosing a candidate unless a provider outage makes the smoke impossible. A smoke failure is evidence, not noise.
- Treat `AutomationRun.notes`, recent browser discoveries, probe history, and deployment notes as a living learning ledger. Each loop should record what went right, what went wrong, what assumption changed, and the next concrete action.
- Repeated work must decay. If the same course, tool, provider, or UI issue has been inspected repeatedly with no new evidence, mark it stale or blocked and rotate to a different evidence-backed candidate.
- A loop that has no fresh queue blocker, smoke failure, provider drift, new research finding, or learnable adapter should return `no_op` instead of inventing polish work.
- Use normalized terminal outcomes: `success`, `no_op`, `needs_adapter`, `blocked_policy`, `blocked_auth`, `blocked_tooling`, `blocked_env`, and `needs_human`.
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

## Boundaries

- Alert only. Do not book, hold, pay, enter checkout, bypass controls, solve verification flows, or use account-specific course sessions.
- Respect policy blockers. If a course prohibits automated retrieval, mark it `BLOCKED` and record a `BLOCKED_POLICY` probe.
- Keep observations per course. A failed course probe must not hide successful probes for other ranked courses.
- Only email newly seen matching slots. Alert suppression dedupes by search, course, and source id so source-local times and stored UTC times cannot trigger duplicate emails.

## Run Contract

Each automation run should:

1. Create an `AutomationRun` row with a prompt version.
2. Load active `TeeSearch` rows and ranked `CoursePreference` rows.
3. Load recent learning signals from `AutomationRun.notes`, `CourseAutomationDiscovery`, current probes, smoke evidence, and deployment notes.
4. Evaluate `Course.automationEligibility` and `policyNotes` before fetching.
5. Use the matching adapter only when `detectedPlatform` and `bookingMetadata` are known.
6. Run a current-tool/design research pass when the selected candidate is UI quality, unsupported automation, or weak tooling.
7. Create or update project accounts/configuration when that is the highest-leverage blocker.
8. Record `CourseProbe` rows for `NO_MATCH`, `MATCH_FOUND`, `NEEDS_ADAPTER`, `FETCH_FAILED`, and blockers.
9. Upsert `TeeTimeMatch` rows for qualifying slots.
10. Send Resend email alerts only for new pending matches, then mark them sent.
11. Run tests, lint, build, and `npm run ui:smoke` for any code or UI change.
12. Finish the `AutomationRun` with outcome, checkpoints, notes, errors, changed files, learning signals, stale candidates, changed assumptions, research decisions, and redacted setup changes when applicable.

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
