# Codex Automation Loop

TeeTimeAI uses Postgres as the queue of user demand and a local Codex automation as the adaptive worker.

## Cadence

- Every 15 minutes: run `npm run automation:poll` against active searches.
- Hourly: run `npm run automation:improve` to create a Codex-ready prompt from recent failures, adapter gaps, and UI friction.
- Before deploys: run `npm run test:run`, `npm run lint`, and `npm run build`.

## Loop Engineering Standard

The loop should improve the product every time it has credible evidence to act. It should not just rerun the same prompt.

- Start each run by writing or confirming checkpoints: `queue_confirmed`, `candidate_selected`, `tool_research_done`, `ui_smoke_done`, `verification_done`, and `outcome_recorded`.
- Use normalized terminal outcomes: `success`, `no_op`, `needs_adapter`, `blocked_policy`, `blocked_auth`, `blocked_tooling`, `blocked_env`, and `needs_human`.
- Keep side effects idempotent. Email alerts, GitHub pushes, and future Slack/GitHub comments need stable keys so a retry cannot duplicate them.
- Use a per-loop lease before mutating shared state so concurrent runs do not work the same candidate.
- Stop cleanly when blocked. Record the blocker and next concrete unblock step instead of exploring indefinitely.

## Tool And Design Escalation

Every improvement run must actively look for better tools when the current approach is not producing a good product.

- Run a short current-tool research pass for UI, automation, maps/search, email, or scraping gaps before picking a new approach.
- For weak UI or UX, compare against current tee-time/waitlist products and AI design tools, then choose one concrete change to ship.
- Use the browser for desktop and mobile smokes on onboarding, course ranking, dashboard state, and email preview.
- If the implemented UI still looks weak after a browser smoke, escalate to a stronger design workflow: Figma/Figma Make, v0, a generated design direction, or another current tool discovered during the research pass.
- Do not blindly adopt generated output. Treat design tools as idea generators, then implement the best parts in the repo's Next.js app with tests and build verification.

## Operational Authority

The hourly improvement loop has broad authority to get TeeTimeAI working end to end.

- It may create and configure project accounts, apps, projects, API keys, deploy targets, OAuth settings, webhooks, DNS records, and integrations needed for TeeTimeAI.
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
- Only email newly seen matching slots. Existing `TeeTimeMatch` rows dedupe by search, course, source id, and start time.

## Run Contract

Each automation run should:

1. Create an `AutomationRun` row with a prompt version.
2. Load active `TeeSearch` rows and ranked `CoursePreference` rows.
3. Evaluate `Course.automationEligibility` and `policyNotes` before fetching.
4. Use the matching adapter only when `detectedPlatform` and `bookingMetadata` are known.
5. Run a current-tool/design research pass when the selected candidate is UI quality, unsupported automation, or weak tooling.
6. Create or update project accounts/configuration when that is the highest-leverage blocker.
7. Record `CourseProbe` rows for `NO_MATCH`, `MATCH_FOUND`, `NEEDS_ADAPTER`, `FETCH_FAILED`, and blockers.
8. Upsert `TeeTimeMatch` rows for qualifying slots.
9. Send Resend email alerts only for new pending matches, then mark them sent.
10. Run tests, lint, build, and a browser smoke for any code or UI change.
11. Finish the `AutomationRun` with outcome, checkpoints, notes, errors, changed files, and redacted setup changes when applicable.

## First Adapter

The initial supported adapter is ForeUP, seeded by:

```powershell
npm run seed:foreup
```

This creates Tashua Knolls and H. Smith Richardson course records with the known public tee-sheet metadata from the earlier local monitor.
