# Codex Automation Loop

Tee Time Spot uses Postgres as the durable source of user demand, per-search Vercel Workflows for operational checks, a demand-sensitive Codex responder for course-support engineering, and a separate six-hour bounded Codex loop for broad product improvement.

## Cadence

- Per search: create/edit/resume/manual-check starts an immediate durable workflow. Before the first customer report, the check inspects public, signed-out, read-only course pages and likely official booking links for reusable provider metadata. The workflow sleeps until its own `nextCheckAt` between checks.
- Booking windows: supported adapters persist course-specific days-ahead and local release times from explicit public provider configuration, provider release messages, or public-specific official booking rules. A future search sleeps until the earliest selected course opens; courses with later windows are skipped until their own release. Ambiguous empty tee sheets remain unknown rather than being labeled not-yet-open.
- The per-search Workflow caps its next wake to any persisted generation-scoped email retry, so normal delivery retry remains timely without a poller. A daily lightweight safety-recovery query restarts only unusually overdue/expired/failed schedules or due outbox work; it does not fetch course availability when the recovery queue is empty.
- Email cadence: the first discovery-backed check sends one setup report containing current results and does not also send an instant match email. Later status reports become due after 8:00 AM in the golfer's timezone, and a new-opening alert on that check satisfies the morning update instead of creating a second email. Internal support state is never described to the customer as "team alerted"; unresolved coverage is presented as an official-site direct check.
- Reopened matches alert again only after they were continuously unavailable for at least 30 minutes, which prevents short provider inventory flaps from creating repeat email noise.
- Course support: the first unresolved `NEEDS_ADAPTER` or `FETCH_FAILED` result opens a persistent internal `CourseSupportIncident` only after official-site discovery has run. The dedicated 10-minute responder groups due incidents by provider family and failure fingerprint, with 5 courses by default and an absolute limit of 20. It restores reusable public read-only monitoring or records a conclusive technical-access/contact/identity disposition. Ordinary one-check `TEST`/`AUTOMATION` searches do not create incidents; explicitly opted-in `syntheticMultiCycle` coverage creates `engineeringOnly` incidents that remain actionable after the source search ends but never send customer or operator support email. Real demand promotes the same incident to customer-demand priority. See [Course-Support Responder](./course-support-responder.md).
- Official-site discovery may follow up to two clearly scored booking-link handoffs after the course homepage. Explicit official private-club plus member-and-guest access evidence becomes an official-site-only blocked classification; explicit course-level statements that tee times are not required and play is first-come, first-served become `WALK_IN` classifications. Multi-use TeeSnap pages are enriched from their public browser-facing configuration and must match the requested course by name while excluding colocated range or simulator inventory, and TeeItUp links are canonicalized to the provider booking root instead of retaining store or gift-certificate paths.
- Every 10 minutes: inspect the course-support queue. Active real demand may claim immediately. Non-customer engineering work may claim only during the single hourly engineering sweep returned by the CLI. Routine deferred results stop before branch creation, dependency installation, or provider research.
- Checkout and lane isolation: the responder uses `C:\dev\TeeTimeAi-CourseSupportResponder` with `tee-time-spot:course-support-writer`; the bounded improvement loop uses `C:\dev\TeeTimeAI-automation` with `tee-time-spot:hourly-improvement-writer`. Each durable owner blocks duplicates only inside its own lane.
- Every six hours: run one bounded autonomous improvement cycle even while a responder batch is active or awaiting recovery. Inspect every non-course-support evidence track, rank structured candidates, and ship one coherent verified batch only when a candidate clears the evidence and safety threshold. Otherwise record `no_action_healthy`; never manufacture churn to satisfy the schedule.
- Baseline UI/access check: run `npm run ui:smoke` locally, or set `UI_SMOKE_BASE_URL=https://teetimespot.com` before `npm run ui:smoke` for production.
- Before deploys: run `npm run test:run`, `npm run lint`, `npm run build`, and `npm run ui:smoke`.

## Course-Support Responder Contract

- Start with `npm run automation:course-support -- inspect`. A durably recorded `no_due_work` or `deferred_busy` result ends before branch creation, install, research, or provider access.
- Claim one homogeneous provider-family/failure-fingerprint batch from a clean `automation/course-support-*` branch at current `origin/main`. Read the ordinal packet, claim every path before editing it, heartbeat the 15-minute lease, fence the candidate release SHA immediately after commit, and use explicit provenance-checked recovery after expiry.
- Use the central provider-capability registry for family, metadata readiness, failure class, fingerprint, runnable status, and consumer disposition. A recognized provider is not automatically runnable, and contradictory provider signals become non-runnable `SOURCE_CONFLICT` evidence until reconciled from a current official source.
- For code remediation, require a new runnable-provider proof whose `CourseProbe.runtimeVersion` equals the exact deployed release SHA and whose observation is newer than the deployment and latest incident. For classification-only remediation, require a current official-source discovery consistent with the persisted final state.
- After terminal remediation evidence, queue each affected active search once through the private Vercel Queue fallback. Its strict payload contains only the internal search id, schedule version, and trigger; retention is 24 hours and consumer concurrency is 2. Persist hashed affected-search references and require complete dispatch, healthy scheduler state, and a fresh post-dispatch check before closeout. Postgres remains authoritative when enqueue or Workflow start fails.
- Provider retrieval has a global two-call semaphore and a one-call mutex per provider family. Recipient/intent edits and email sends serialize through `alertGeneration` plus the durable `SearchEmailDelivery` outbox, with stable idempotency and a durable Workflow wake no later than the persisted delivery retry time.
- Close unresolved transient failures with the persisted 15-minute, 1-hour, 6-hour, then 24-hour retry ladder, with jitter and bounded `Retry-After` handling. Never archive a retryable result without a future `nextAttemptAt`.
- Auto-archive only routine, durably closed responder tasks: no due work, durably deferred busy work, success, classification-only, partial, or scheduled retry. Keep active/recovery/human, privacy, delivery, unsafe-provider, migration/deploy/production-verification, auth/env/Git, command, and repeated-SLA results visible.
- Apply the additive dispatcher migration before dependent code. For the existing stress cohort, dry-run and apply the bounded synthetic-remediation backfill before dry-running/applying the responder-state backfill; neither may make provider requests. Start rollout with three inspect-only cycles, keep batches at 5 for three clean completions, and never exceed 20.

The full state machine, command syntax, rollback, and privacy contract are in [Course-Support Responder](./course-support-responder.md).

## Loop Engineering Standard

The loop should improve the product every time it has credible evidence to act. It should not just rerun the same prompt.

- Start each run by writing or confirming checkpoints: `queue_confirmed`, `candidate_selected`, `provenance_recorded`, `tool_research_done`, `ui_smoke_done`, `verification_done`, `git_committed`, `git_pushed`, `production_verified`, and `outcome_recorded`.
- Run `npm run automation:inspect` and `npm run ui:smoke` before choosing a candidate unless a provider outage makes the smoke impossible. A smoke failure is evidence, not noise.
- Treat `AutomationRun.notes`, `WebsiteEvent`, `WebsiteFeedback`, recent browser discoveries, probe history, and deployment notes as a living learning ledger. Saved `TeeSearch` demand carries the same aggregate `PUBLIC`, `UNCLASSIFIED`, `AUTOMATION`, or `TEST` provenance as funnel events. The dedicated responder owns all incident remediation and synthetic-vs-real-demand fairness; the broad hourly loop may inspect aggregate coverage evidence but may not claim a course-support incident as its candidate. Each loop should record what went right, what went wrong, what assumption changed, and the next concrete action.
- Treat `operations_incidents`, `search_discovery`, `ui_ux`, `accessibility`, `dashboard_auth`, `email_alerts`, `reliability_security`, `performance`, `metadata_seo`, `analytics_observability`, and `test_developer_tooling` as the canonical improvement portfolio. Persist `selectedCategory`, a non-empty `candidateRanking`, and the recent selection history in structured `AutomationRun` audit data so diversification is enforced by code rather than remembered only in prose.
- The inspection output includes up to three `courseProfileQueue` records. When no higher-priority non-course-support issue is active, the loop may claim them together as one `metadata_seo` batch, research only authoritative sources, write confident facility-focused public prose without exposing the research process, validate with `npm run automation:course-profile`, and publish only passing profiles. Failed evidence must leave alert creation and monitoring intact.
- Pending delivery and customer-safety incidents keep absolute priority. Course-support incidents belong exclusively to the 10-minute responder. When that queue is empty, rank feedback, funnel, browser, email, performance, metadata, security, aggregate coverage, and learning signals together. Give the least-recently shipped eligible category a diversity bonus, decay repeated categories, and block a third consecutive discretionary `search_discovery` selection unless real BROKEN feedback supplies the override.
- ZIP/location exploration creates evidence; it does not automatically authorize the shipped change. Do not piggyback a discretionary course/search correction onto a non-search release. Preserve it in the ranked follow-up list unless it is a current production incident or real BROKEN feedback.
- Every successful closeout must record a non-empty result for `operations_errors`, `browser_location`, `feedback_discord_behavior`, `missing_course_search`, `current_practice_research`, and `product_quality`. A result may be healthy, empty with sample counts, unavailable with an exact blocker, or actionable, but it may not be omitted. The same access gap in three successful runs becomes a durable coverage blocker rather than another harmless note. Preparation keeps that blocker in `portfolio.rankedSignals` with its concrete unblock action, but a coverage-only signal does not satisfy `candidate_selected` or terminate a run before the required current-run exploration. A terminal `needs_human` decision still requires current evidence that no safe in-scope improvement can proceed.
- `TEST` and `AUTOMATION` searches complete after their first successful workflow check by default. A synthetic harness that genuinely needs repeated provider cycles must opt in explicitly with the bounded `x-tee-time-spot-synthetic-multi-cycle: true` creation header; those searches may create non-notifying engineering-only remediation incidents. Public and unclassified demand always retains normal scheduling and customer-demand incident semantics.
- Repeated exploratory work must decay. If the same non-incident course, tool, provider, or UI issue has been inspected repeatedly with no new evidence, mark it stale or blocked and rotate to a different evidence-backed candidate. The responder, not the hourly loop, keeps open course-support work alive until reusable monitoring or a final disposition is proved.
- When the first evidence pass has no credible candidate, perform one bounded rotation through the least-recently covered evidence surfaces. If every required track is accounted for and no candidate clears the customer-value, confidence, safety, and end-to-end verification threshold, close as `no_action_healthy` with the evaluated candidates and measured healthy evidence.
- Use normalized terminal outcomes: `success`, `no_action_healthy`, `incident`, `blocked_policy`, `blocked_auth`, `blocked_tooling`, `blocked_env`, `blocked_dirty_worktree`, `blocked_git`, `blocked_concurrent`, and `needs_human`. `needs_adapter` is responder queue evidence, not a valid broad-loop candidate or closeout.
- Keep side effects idempotent. Email alerts, GitHub pushes, and future Slack/GitHub comments need stable keys so a retry cannot duplicate them.
- Acquire the hourly-specific transaction-scoped `tee-time-spot:hourly-improvement-writer` lease before hourly preparation, path claims, and closeout. The single unfinished hourly owner `AutomationRun` is the durable rest-of-run guard. Another unfinished hourly run inside its active window is `blocked_concurrent`; responder activity is not.
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
- Create a clear imperative or Conventional Commit on the run's task branch, record its SHA, fetch and rebase onto current `origin/main` when needed, rerun affected verification, and use the preflight command `git push origin HEAD:main`. The responder may advance `origin/main` concurrently, so always use the fresh fetch/rebase check; if the push is rejected or the remote moves again, stop with `blocked_git` rather than force-pushing or rewriting another lane's history.
- For an additive, backward-compatible Prisma migration, run production migration status/deploy with the Vercel production environment before the app deployment. Destructive migrations, irreversible data changes, or broad backfills require fresh user approval.
- For live-impacting commits, use `git push origin HEAD:main` as the only normal production deployment trigger, then run `npm run deployment:wait -- --sha <commitSha>` to require the Git integration deployment for that exact commit, `Ready`, and both production aliases. Do not follow a normal Git push with `npx vercel --prod --yes`; reserve direct CLI production deployment for an explicitly chosen recovery action. Docs-only and local-operator-only changes still require a commit and push but do not need deployment verification.
- After deployment, require `Ready`, the `teetimespot.com` and `www.teetimespot.com` aliases, production UI smoke, key route/API checks, recent error-log inspection, and confirmation that the deployed behavior corresponds to the pushed commit.
- If production verification fails because of the new release, stop further improvement work and report `incident`. Prefer a safe rollback to the previous verified deployment only when no incompatible migration or irreversible state change is involved; otherwise require human intervention.
- Terminal exceptions must atomically close the owned `AutomationRun` with a redacted error, concrete blocker, `completedAt`, terminal outcome, and `outcome_recorded=true`. If no database write is possible, the external automation task must report that evidence gap explicitly.

## Boundaries

- Alert only. Do not book, hold, pay, enter checkout, bypass controls, solve verification flows, or use account-specific course sessions.
- Booking or transaction policy text alone never blocks public read-only monitoring. Re-check the current signed-out surface and keep adapter investigation open unless present technical evidence proves account, CAPTCHA/queue, rate-limit, or other access-control gating.
- Keep observations per course. A failed course probe must not hide successful probes for other ranked courses.
- Only email newly seen matching slots. Availability reconciliation uses the search, course, provider source id, and exact course-local instant so a corrected timestamp retires stale shifted rows instead of keeping duplicate availability alive.

## Run Contract

Each automation run should:

1. Inspect the responder queue for aggregate context, then acquire the independent hourly transition lease. Never stop hourly work because a responder batch is active, expired, or due; never select that work as an hourly candidate. After hourly preparation, treat the unfinished hourly owner `AutomationRun` as the durable rest-of-run guard.
2. Create a unique named task branch from current `origin/main`, confirm it is clean and synchronized, and record the branch, starting SHA, and preflight `git push origin HEAD:main` command.
3. Create one owner `AutomationRun` row with a prompt version and keep it open through implementation.
4. Load active `TeeSearch` rows and ranked `CoursePreference` rows.
5. Load current evidence from `WebsiteEvent`, `WebsiteFeedback`, recent learning signals, aggregate `CourseAutomationDiscovery`/probe health, smoke evidence, deployment notes, and recent Vercel logs. Use the inspector's concise 24-hour `recentImprovementRuns` memory instead of relying on the global recent-run sample, which can be crowded out by frequent event-driven checks. Use its 24-hour event counts plus course-discovery result/failure buckets by traffic class to evaluate page views, empty discovery, provider failures, and alert creation without treating automation traffic as public funnel evidence. Do not load open `CourseSupportIncident` rows into the hourly candidate portfolio.
6. Drain already-found real-demand pending alerts, then build and rank structured portfolio candidates from real feedback, PUBLIC funnel thresholds, browser/UI evidence, email state, performance, metadata/security, aggregate coverage blockers, and living follow-ups. Apply the category diversity rules before selection. Keep repeated access gaps visible in the final coverage-blocker audit, but route provider/course incident remediation to the responder. When the first pass is empty or contains only coverage gaps, broaden the evidence rotation once and close `no_action_healthy` if nothing clears the decision threshold.
7. Before editing, persist the exact owner/provenance/planned-path record and set `provenance_recorded=true`.
8. Evaluate the reusable course-intelligence snapshot (`bookingMethod`, `automationEligibility`, `automationReason`, `policyNotes`, and review date) before fetching. Terminal findings such as phone-only booking must not return to normal per-search adapter probing; surface them as dedicated review work once `intelligenceReviewAt` is due.
9. Use the matching adapter only when `detectedPlatform` and `bookingMetadata` are known.
10. Run a current-tool/design research pass only when it can change the selected implementation strategy.
11. Implement one coherent batch of compatible non-course-support improvements within the selected category with focused tests and documentation where behavior changed. Do not use a non-search batch as cover for a discretionary course correction or adapter remediation.
12. Preserve `CourseProbe` and incident evidence as read-only context for aggregate product health. Do not create provider observations merely to satisfy an hourly candidate.
13. Leave course-support claim, provider research, adapter changes, post-deploy search rechecks, classification, retry, and human escalation to the dedicated responder. Keep internal incident and operator-delivery state out of customer copy.
14. Upsert `TeeTimeMatch` rows and send Resend alerts only through the normal idempotent worker path.
15. Enter closeout under the 40-minute/20-minute budget and start no new exploration or edits.
16. Run focused verification plus `npm run test:run`, `npm run lint`, `npm run build`, `npm run ui:smoke`, and `git diff --check`.
17. Inspect the final diff, stage only intended files, create coherent commits, and run the push command reported by preflight without force.
18. Apply only safe additive production migrations, push live-impacting work to `origin/main`, and wait for the exact Git-created Vercel deployment with `npm run deployment:wait -- --sha <commitSha>`.
19. Verify the production deployment source, aliases, routes/APIs, desktop/mobile smoke, logs, and expected behavior, then confirm the task branch is clean and checked-out `HEAD` matches `origin/main` after the push.
20. Atomically finish the owner `AutomationRun` and automation memory with the selected category, ranked candidates, all evidence-track results, coverage blockers, outcome, checkpoints, commit SHA, deployment ID, changed files, verification, learning signals, changed assumptions, blockers, `completedAt`, and `outcome_recorded=true`.

The repo exposes durable state transitions through the improvement command:

```powershell
# Prepare/select and create the unfinished owner AutomationRun.
npm run automation:improve

# After candidate selection and before edits; repeat --path for every owned path.
npm run automation:improve -- claim --run-id <run-id> --path <repo-relative-path> --candidate-summary "<evidence-backed candidate>" --candidate-category <portfolio-category>

# At terminal closeout, pipe one JSON object containing outcome, checkpoints,
# changedFiles, deploymentRequired, audit, and blockerReasons/errors when blocked.
$closeout | ConvertTo-Json -Depth 12 | npm run automation:improve -- closeout --run-id <run-id>
```

`CODEX_THREAD_ID` supplies owner-thread provenance. A runtime without it must pass the real current id through `--owner-thread`; it may not invent one. Dirty recovery is a separate explicit invocation from that same owner thread: `npm run automation:improve -- prepare --recover-run <run-id>`. Preparation, claim, recovery, and closeout all use the short state-transition lease. The unfinished row prevents a second run from starting after that lease is released.

The closeout command requires structured audit keys for `commitSha`, `pushResult`, `migration`, `deploymentId`, `productionVerification`, `zipLocationsExplored`, `devicesExplored`, `routesExplored`, `scenariosExplored`, `errorLogFindings`, `feedbackDispositions`, `discordCoverage`, `missingCourseResearch`, `researchSources`, `rejectedCandidates`, `selectedCategory`, `candidateRanking`, `evidenceTrackResults`, `coverageBlockers`, `learning`, `blockers`, `changedBehavior`, `measuredResult`, and `nextRotationTargets`; it adds the authoritative branch, starting SHA, Git-derived committed paths, dirty paths, and unplanned residue. A successful run requires a valid selected category matching the claimed candidate, at least one ranked candidate, a non-empty result for all six canonical evidence tracks, a checked-out commit, verified push parity, production-verification evidence, and a deployment id when `deploymentRequired=true`. Empty evidence arrays remain valid only where the corresponding evidence-track result explains the checked state and sample or blocker. Unknown audit fields are rejected; audit/error strings are bounded and redact credential-like keys, bearer values, and sensitive URL parameters before persistence. Course-support closeout uses the separate responder command and evidence contract.

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
