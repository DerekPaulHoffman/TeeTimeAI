# Codex Automation Loop

Tee Time Spot uses Postgres as the queue of user demand, durable per-search Vercel Workflows for operational checks, and a local Codex automation only for product improvement.

## Cadence

- Per search: create/edit/resume/manual-check starts an immediate durable workflow. Before the first customer report, the check inspects policy-safe public course pages and likely official booking links for reusable provider metadata. The workflow sleeps until its own `nextCheckAt` between checks.
- Booking windows: supported adapters persist course-specific days-ahead and local release times from explicit public provider configuration, provider release messages, or public-specific official booking rules. A future search sleeps until the earliest selected course opens; courses with later windows are skipped until their own release. Ambiguous empty tee sheets remain unknown rather than being labeled not-yet-open.
- Daily recovery: query only for overdue or failed workflow schedules and restart those searches; do not fetch course availability when the recovery queue is empty.
- Email cadence: the first discovery-backed check sends one setup report containing current results and does not also send an instant match email. Later status reports become due after 8:00 AM in the golfer's timezone, and a new-opening alert on that check satisfies the morning update instead of creating a second email. Internal support state is never described to the customer as "team alerted"; unresolved coverage is presented as an official-site direct check.
- Reopened matches alert again only after they were continuously unavailable for at least 30 minutes, which prevents short provider inventory flaps from creating repeat email noise.
- Course support: the first unresolved `NEEDS_ADAPTER` or `FETCH_FAILED` result opens a persistent internal `CourseSupportIncident` only after official-site discovery has run. The search workflow retries lightweight discovery once after 30 minutes, while the incident immediately becomes an urgent adapter-remediation candidate for the hourly engineering loop. Age and repeated discovery never turn it into an owner request. `NEEDS_HUMAN` and the provider-grouped operator email are reserved for an hourly remediation run that records concrete attempts, evidence, the failed result, and one exact unavoidable external action. Resolution email is sent only when an owner was previously notified and monitoring later succeeds or direct-booking classification is verified.
- Hourly: run one complete autonomous improvement cycle: inspect evidence, select one candidate, implement it, verify it, commit it, push it, deploy live-impacting work, verify production, and record what was learned.
- Baseline UI/access check: run `npm run ui:smoke` locally, or set `UI_SMOKE_BASE_URL=https://teetimespot.com` before `npm run ui:smoke` for production.
- Before deploys: run `npm run test:run`, `npm run lint`, `npm run build`, and `npm run ui:smoke`.

## Loop Engineering Standard

The loop should improve the product every time it has credible evidence to act. It should not just rerun the same prompt.

- Start each run by writing or confirming checkpoints: `queue_confirmed`, `candidate_selected`, `provenance_recorded`, `tool_research_done`, `ui_smoke_done`, `verification_done`, `git_committed`, `git_pushed`, `production_verified`, and `outcome_recorded`.
- Run `npm run automation:inspect` and `npm run ui:smoke` before choosing a candidate unless a provider outage makes the smoke impossible. A smoke failure is evidence, not noise.
- Treat `AutomationRun.notes`, `WebsiteEvent`, `WebsiteFeedback`, recent browser discoveries, probe history, and deployment notes as a living learning ledger. Each loop should record what went right, what went wrong, what assumption changed, and the next concrete action.
- Repeated exploratory work must decay. If the same non-incident course, tool, provider, or UI issue has been inspected repeatedly with no new evidence, mark it stale or blocked and rotate to a different evidence-backed candidate. Open adapter-remediation incidents do not decay: complete the reusable adapter, persist a conclusive direct-booking/policy classification, or prove a concrete blocker.
- The hourly workflow may not return `no_op`. When the first evidence pass has no open support incident, fresh queue blocker, smoke failure, provider drift, research finding, or learnable adapter, record the nonterminal state `exploration_required` and rotate to least-recently covered locations, devices, routes, feedback, missing-course evidence, accessibility, performance, security, metadata, and current-practice sources. Continue until the run ships a safe valuable improvement or reaches a concrete blocker. Do not manufacture meaningless churn. This hourly rule does not change legitimate `no_op` outcomes for event-driven checks or browser probes.
- Use normalized terminal outcomes: `success`, `incident`, `needs_adapter`, `blocked_policy`, `blocked_auth`, `blocked_tooling`, `blocked_env`, `blocked_dirty_worktree`, `blocked_git`, `blocked_concurrent`, and `needs_human`. `exploration_required` is not terminal. `needs_adapter` may describe fresh queue evidence, but it is not a valid closeout once that incident is selected for adapter remediation.
- Keep side effects idempotent. Email alerts, GitHub pushes, and future Slack/GitHub comments need stable keys so a retry cannot duplicate them.
- Acquire the short transaction-scoped hourly initialization/state-update lease before candidate selection, path claims, and closeout. It serializes those database transitions; the single unfinished owner `AutomationRun` is the durable rest-of-run guard. An unfinished run inside its active window is `blocked_concurrent`.
- Stop cleanly when blocked. Record the blocker and next concrete unblock step instead of exploring indefinitely.
- Enter closeout no later than 40 minutes after the run starts or whenever only 20 minutes remain before the next scheduled launch. Start no new exploration or file edits after that point; reserve the closeout budget for verification, diff review, commit, rebase, push, deployment, production verification, and the durable final record.

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
- Before every run, fetch `origin/main` and create a unique named task branch such as `automation/hourly-YYYYMMDD-HHmmss` from it. Never work, commit, or remain on `main`, and never leave the run detached.
- Run `npm run automation:preflight` immediately after branch creation. The preflight fetches `origin`, accepts only a clean named task branch, fast-forwards a branch that is only behind, reports `git push origin HEAD:main`, and returns `blocked_dirty_worktree` or `blocked_git` before the expensive loop starts.
- Preflight is dependency-free so it can run before `npm install` in a fresh worktree. After the gate passes, install lockfile-declared dependencies when `node_modules` is absent.
- Keep ignored local operator configuration available to future Codex-managed worktrees through `.worktreeinclude`; never commit the copied secret/config files themselves.
- Start by confirming the task branch is clean and its `HEAD` is not ahead of or diverged from `origin/main`.
- When the tree is clean and `HEAD` is only behind, update it with a fast-forward-only merge of `origin/main` before selecting work.
- If unrelated or unexplained changes already exist, do not stage, commit, overwrite, revert, or deploy them. Stop with `blocked_dirty_worktree` and identify the paths. The only resumable dirty state is owned work from the immediately preceding unfinished run for this same hourly automation, with an explicit recovery claim and exact matches for owner run, recorded owner thread, branch, expected `HEAD`, and a dirty-path subset of the pre-edit planned paths. Any missing or mismatched provenance is `blocked_dirty_worktree`.
- Before the first edit, persist the automation id, owner `AutomationRun` id, Codex thread id, branch, starting and expected `HEAD`, exact planned paths, and `provenance_recorded=true`. Persist additions before touching any path outside the initial plan. Keep `outcome_recorded=false` until atomic closeout.
- Keep each run to one coherent batch of compatible improvements and stage only its intended files. Never use `git add -A` without first proving every changed path belongs to the run.
- Do not commit until focused tests, `npm run test:run`, `npm run lint`, `npm run build`, `npm run ui:smoke`, and `git diff --check` pass for a code change.
- Create a clear imperative or Conventional Commit on the run's task branch, record its SHA, fetch and rebase onto current `origin/main` when needed, rerun affected verification, and use the preflight command `git push origin HEAD:main`. If the push is rejected or the remote moved, stop with `blocked_git`; do not force-push or rewrite history.
- For an additive, backward-compatible Prisma migration, run production migration status/deploy with the Vercel production environment before the app deployment. Destructive migrations, irreversible data changes, or broad backfills require fresh user approval.
- For live-impacting commits, use `git push origin HEAD:main` as the only normal production deployment trigger, then run `npm run deployment:wait -- --sha <commitSha>` to require the Git integration deployment for that exact commit, `Ready`, and both production aliases. Do not follow a normal Git push with `npx vercel --prod --yes`; reserve direct CLI production deployment for an explicitly chosen recovery action. Docs-only and local-operator-only changes still require a commit and push but do not need deployment verification.
- After deployment, require `Ready`, the `teetimespot.com` and `www.teetimespot.com` aliases, production UI smoke, key route/API checks, recent error-log inspection, and confirmation that the deployed behavior corresponds to the pushed commit.
- If production verification fails because of the new release, stop further improvement work and report `incident`. Prefer a safe rollback to the previous verified deployment only when no incompatible migration or irreversible state change is involved; otherwise require human intervention.
- Terminal exceptions must atomically close the owned `AutomationRun` with a redacted error, concrete blocker, `completedAt`, terminal outcome, and `outcome_recorded=true`. If no database write is possible, the external automation task must report that evidence gap explicitly.

## Boundaries

- Alert only. Do not book, hold, pay, enter checkout, bypass controls, solve verification flows, or use account-specific course sessions.
- Respect policy blockers. If a course prohibits automated retrieval, mark it `BLOCKED` and record a `BLOCKED_POLICY` probe.
- Keep observations per course. A failed course probe must not hide successful probes for other ranked courses.
- Only email newly seen matching slots. Availability reconciliation uses the search, course, provider source id, and exact course-local instant so a corrected timestamp retires stale shifted rows instead of keeping duplicate availability alive.

## Run Contract

Each automation run should:

1. Acquire the hourly initialization/state-update lease; after preparation, treat the unfinished owner `AutomationRun` as the durable rest-of-run guard.
2. Create a unique named task branch from current `origin/main`, confirm it is clean and synchronized, and record the branch, starting SHA, and preflight `git push origin HEAD:main` command.
3. Create one owner `AutomationRun` row with a prompt version and keep it open through implementation.
4. Load active `TeeSearch` rows and ranked `CoursePreference` rows.
5. Load current evidence from open `CourseSupportIncident` rows, `WebsiteEvent`, `WebsiteFeedback`, recent learning signals, `CourseAutomationDiscovery`, current probes, smoke evidence, deployment notes, and recent Vercel logs.
6. Drain already-found pending alerts, then select every open course-support incident affecting active demand ahead of exploratory product work. Treat it as autonomous engineering remediation, not an owner support request. After incidents, prefer real-user blockers, alert failures, adapter gaps, funnel regressions, repeated feedback, and verified UI/access failures. When the first pass is empty, record `exploration_required`, broaden the evidence rotation, and continue.
7. Before editing, persist the exact owner/provenance/planned-path record and set `provenance_recorded=true`.
8. Evaluate the reusable course-intelligence snapshot (`bookingMethod`, `automationEligibility`, `automationReason`, `policyNotes`, and review date) before fetching. Terminal findings such as phone-only booking must not return to normal per-search adapter probing; surface them as dedicated review work once `intelligenceReviewAt` is due.
9. Use the matching adapter only when `detectedPlatform` and `bookingMetadata` are known.
10. Run a current-tool/design research pass only when it can change the selected implementation strategy.
11. Implement one coherent batch of compatible improvements with focused tests and documentation where behavior changed. Adapter remediation must inspect the current official provider and policy surface, use only policy-safe public unauthenticated retrieval, build or extend a reusable provider adapter (including metadata discovery and booking-window evidence when available), and rerun the affected search. If retrieval is prohibited or no online booking exists, persist that classification and resolve the incident.
12. Record `CourseProbe` rows for `NO_MATCH`, `MATCH_FOUND`, `NEEDS_ADAPTER`, `FETCH_FAILED`, and blockers when worker behavior is explicitly verified. Browser probing must prioritize courses with open incidents.
13. Open and resolve course-support incidents through the normal discovery-first search-check paths. Only the hourly closeout may escalate an adapter-remediation incident to `NEEDS_HUMAN`, and only when its structured `adapterRemediation` audit proves prior automated attempts plus the exact external action required. Keep internal incident and operator-delivery state out of customer copy.
14. Upsert `TeeTimeMatch` rows and send Resend alerts only through the normal idempotent worker path.
15. Enter closeout under the 40-minute/20-minute budget and start no new exploration or edits.
16. Run focused verification plus `npm run test:run`, `npm run lint`, `npm run build`, `npm run ui:smoke`, and `git diff --check`.
17. Inspect the final diff, stage only intended files, create coherent commits, and run the push command reported by preflight without force.
18. Apply only safe additive production migrations, push live-impacting work to `origin/main`, and wait for the exact Git-created Vercel deployment with `npm run deployment:wait -- --sha <commitSha>`.
19. Verify the production deployment source, aliases, routes/APIs, desktop/mobile smoke, logs, and expected behavior, then confirm the task branch is clean and checked-out `HEAD` matches `origin/main` after the push.
20. Atomically finish the owner `AutomationRun` and automation memory with outcome, evidence, checkpoints, commit SHA, deployment ID, changed files, verification, learning signals, changed assumptions, blockers, `completedAt`, and `outcome_recorded=true`.

The repo exposes durable state transitions through the improvement command:

```powershell
# Prepare/select and create the unfinished owner AutomationRun.
npm run automation:improve

# After candidate selection and before edits; repeat --path for every owned path.
npm run automation:improve -- claim --run-id <run-id> --path <repo-relative-path> --candidate-summary "<evidence-backed candidate>"

# At terminal closeout, pipe one JSON object containing outcome, checkpoints,
# changedFiles, deploymentRequired, audit, and blockerReasons/errors when blocked.
$closeout | ConvertTo-Json -Depth 12 | npm run automation:improve -- closeout --run-id <run-id>
```

`CODEX_THREAD_ID` supplies owner-thread provenance. A runtime without it must pass the real current id through `--owner-thread`; it may not invent one. Dirty recovery is a separate explicit invocation from that same owner thread: `npm run automation:improve -- prepare --recover-run <run-id>`. Preparation, claim, recovery, and closeout all use the short state-transition lease. The unfinished row prevents a second run from starting after that lease is released.

The closeout command requires structured audit keys for `commitSha`, `pushResult`, `migration`, `deploymentId`, `productionVerification`, `zipLocationsExplored`, `devicesExplored`, `routesExplored`, `scenariosExplored`, `errorLogFindings`, `feedbackDispositions`, `discordCoverage`, `missingCourseResearch`, `researchSources`, `rejectedCandidates`, `learning`, `blockers`, `changedBehavior`, `measuredResult`, and `nextRotationTargets`; it adds the authoritative branch, starting SHA, Git-derived committed paths, dirty paths, and unplanned residue. Use empty arrays, an explicit unavailable string, or `null` for stages a blocked run did not reach. A successful run must identify the checked-out commit, have verified push parity, include production-verification evidence, and include a deployment id when `deploymentRequired=true`. An adapter-remediation `needs_human` closeout must also include `adapterRemediation: { incidentId, attempts, evidence, result, requiredExternalAction }`; without that exact concrete evidence, closeout is rejected and no owner email is sent. Unknown audit fields are rejected; audit/error strings are bounded and redact credential-like keys, bearer values, and sensitive URL parameters before persistence.

## UI Smoke Contract

The hourly loop should treat UI/access problems as product bugs. The smoke must pass before `ui_smoke_done` is true.

Before any autonomous browser navigation, set `sessionStorage["tee-time-spot:traffic-class"]` to `AUTOMATION`; use `TEST` only for an explicit manual test. The marker is an aggregate traffic class, never a visitor/session identifier. Verify the analytics request carries it. If the marker cannot be applied, do not let that browser persist unmarked public-funnel events; repair the harness or stop with `blocked_tooling`.

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
