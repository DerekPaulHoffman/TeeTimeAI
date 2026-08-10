# Course-Support Responder

The course-support responder is the dedicated engineering path for persistent `NEEDS_ADAPTER`, `FETCH_FAILED`, and reader-candidate outcomes. It checks for due work every 10 minutes, groups reusable work, and either restores public read-only monitoring or records an authoritative manual, identity, or technical limitation. Human review remains only for ambiguous evidence or a concrete external action. It is separate from per-search scheduling and from the broad product-improvement loop.

## Ownership And Cadence

- Vercel Workflows remain the scheduler for golfer searches. The responder does not poll tee sheets on a timer and does not replace a search workflow.
- The Codex automation `tee-time-spot-course-support-responder` begins every 10-minute task with `npm run automation:course-support -- inspect`.
- Every responder launch runs in its own Codex-created worktree. The bounded product-improvement loop remains in `C:\dev\TeeTimeAI-automation`; they never share one mutable checkout.
- Before installing dependencies in a generated worktree, run `npm run automation:course-support:preflight -- --run`. It reuses an approved prepared responder checkout for the production `inspect` command when available and returns a structured setup requirement otherwise. This keeps empty or deferred launches from spending their useful window rebuilding dependencies.
- A due batch contains one provider family and one failure fingerprint. The default claim is 5 courses; the command clamps all requests to 1 through 20.
- Batches prioritize near-date active real-demand fetch failures, then other active real demand, then historical non-engineering incidents whose searches have ended, then engineering-only synthetic coverage. Aged engineering-only evidence receives bounded fairness when no critical real demand is waiting.
- Every 10-minute run may claim one bounded provider/fingerprint group with no more than five courses. Up to three different groups may run concurrently in isolated worktrees. Provider work retains the global two-request limit and one request per provider family; durable group ownership prevents duplicate work.
- Each task records its provider group and bounded course ordinals at claim time and must end with a durable batch closeout (`success`, `classification_only`, `partial`, `retryable_failed`, or `needs_human`) or one concrete visible blocker. Passing local tests is not a closeout: when production still cannot produce trustworthy evidence, the task records the observed provider failure, performs the best safe reusable fix or terminal classification available, and persists the exact next attempt or engineering action.
- The broad product-improvement loop uses an independent writer lane and may proceed while a responder batch is active or requires recovery. Responder state remains informational there, and course-support incidents are never portfolio candidates for that loop.

`CourseSupportIncident` is the durable per-course problem. `CourseSupportBatch` is the short-lived provider-family/fingerprint engineering claim. `CourseSupportBatchIncident` preserves the per-course pre-remediation evidence and final batch result.

## Provider Registry And Consumer Outcomes

Provider identity and runnable support come from `src/lib/automation/provider-capabilities.ts`, not scattered platform switches or optimistic URL guesses.

- Runnable families are `FOREUP`, `TEEITUP`, `CHRONOGOLF`, `CPS`, `CHELSEA`, `TEESNAP`, `GOLFBACK`, `WEBTRAC`, `CLUB_CADDIE`, and `WHOOSH` when their required metadata validates. WHOOSH reads only signed-out `GOLF_COURSE` facilities; driving-range and other activity inventory is rejected.
- `EZLINKS` remains non-runnable from the server dispatcher because its public search is challenge-protected, but safe one-label tenant pages may run through the compatible rendered local reader. `GOLFNOW` remains recognized but non-runnable. `TENFORE` uses its rendered local reader. Recognition alone is not proof of monitoring support.
- Missing official source, missing metadata, unsupported family, authentication, rate limit, challenge, not-found, provider 5xx, timeout, network, schema, and unknown failures are classified separately.
- Contradictory persisted provider signals resolve to `SOURCE_CONFLICT`, which is deliberately non-runnable. No provider request may run until current official-source evidence reconciles the platform, booking URL, and metadata to one family.
- `Course.monitoringMode` is the durable per-course routing strategy. `AUTOMATIC` uses the normal provider dispatcher and may use a safe fallback; `SERVER_ONLY` never queues a local reader; `BROWSER_ONLY` and `LOCAL_READER_ONLY` require the signed rendered-page reader; and `CONTACT_ONLY` is a terminal known limitation backed by current official evidence. Reader-only and contact-only courses bypass ordinary HTTP discovery instead of repeatedly rediscovering the same failure.
- Reader jobs declare a parser capability and minimum version. A reader reports its build and capabilities on every signed poll, and the backend leases only compatible jobs. Generic safe CPS, TenFore, and public Chronogolf routes use reusable parsers without course-specific extension releases. When a compatible reader comes online, a prior `READER_RELOAD_REQUIRED` incident is automatically returned to investigation for exact revalidation.
- A failure fingerprint is a hash of the normalized provider family, failure class, operation, and HTTP status bucket. It contains no course name, recipient, URL, token, or raw error text.

Customer-facing readiness is derived independently from internal engineering state. The canonical dispositions are `MATCH_AVAILABLE`, `CHECKED_NO_MATCH`, `BOOKING_NOT_OPEN`, `DIRECT_SITE_ONLY`, `PHONE_OR_WALK_IN`, `ACCOUNT_REQUIRED`, `POLICY_BLOCKED`, `CAPTCHA_OR_QUEUE`, `PRIVATE_OR_INVALID`, `SOURCE_UNVERIFIED`, `RETRYING`, and `ENGINEERING`. Only `MATCH_AVAILABLE`, `CHECKED_NO_MATCH`, and `BOOKING_NOT_OPEN` count as effective monitored coverage.

Customer report finality is also independent from engineering resolution. A completed
`NEEDS_ADAPTER` or `FETCH_FAILED` first check is a final current alert result: tell the
golfer that automatic alerts are unavailable, provide the safest official action, and
keep the durable support incident open for remediation. Never relabel that completed
result as "monitoring setup in progress." Only `CHECK_PENDING` may hold the initial
status email while a bounded public-page reader job is actually active. Search Workflow
retries that job every two minutes; after its five-minute attempt window, record the
failure and deliver the final current setup report. The customer target is one setup
report covering all selected courses within ten minutes of alert creation.

A responder may close a course automatically without runnable monitoring for authoritative phone/contact/walk-in evidence, a verified invalid/private identity, or a current source-backed technical access limitation after safe read paths are exhausted. Contact-only finalization requires an explicit `CONTACT_ONLY` strategy plus a same-origin HTTPS official source; an old manual flag or third-party URL is insufficient. Account-required and CAPTCHA/queue evidence may become a precise known technical limitation, but the responder must never bypass the restriction. Source-unverified, contradictory, stale, reader-install, and official-link verification failures remain human-review states. `AUTOMATION_PROHIBITED` and policy text are legacy evidence, never terminal monitoring dispositions. Restored runnable monitoring remains stricter and must supersede the newest failure with fresh exact-runtime workflow proof.

## Durable Monitoring Lifecycle

`CourseMonitoringStatus` is the one-row current state for each course. `CourseMonitoringEvent` is its append-only, redacted operator history. Search-scoped probes remain on `CourseProbe`; source evidence remains on `CourseAutomationDiscovery`.

- `HEALTHY`: the latest public signed-out read returned `MATCH_FOUND` or `NO_MATCH`.
- `DEGRADED_RETRYING`: the first failure is recorded without erasing the last working time. The search retries within two minutes.
- `AUTO_INVESTIGATING`: two independent read paths failed within 15 minutes, or the same path failed twice. Active real demand gets a six-hour automation deadline; inactive engineering work gets 30 minutes.
- `ENGINEERING_VERIFICATION_NEEDED`: the bounded playbook could not prove recovery or a safe automatic final. Active demand retries every six hours with daily operator reminders. Inactive work retries and reminds weekly.
- `FINAL_MANUAL` and `FINAL_IDENTITY`: strong official manual-booking or identity evidence may close automatically.
- `FINAL_TECHNICAL`: current authoritative evidence proves a precise technical limitation after safe automation is exhausted. It has no timer-based retry. New real demand triggers exactly one revalidation while keeping the prior decision visible.

If independent verification cannot complete the first-failure window, the five-minute watchdog records an explicit tooling incident instead of leaving the course degraded indefinitely. A successful read from any safe retry restores `HEALTHY` automatically. Material changes to the official link, provider family, access evidence, or failure fingerprint reopen automated investigation.

## Claim, Lease, And Repository Safety

Claiming requires all of the following:

- a clean `automation/course-support-*` task branch;
- checked-out `HEAD` exactly equal to current `origin/main`;
- the real Codex task id from `CODEX_THREAD_ID` or `--owner-thread`;
- fewer than three healthy active responder batches, with no active batch for the selected provider-family/failure-fingerprint group.

Claim returns a redacted `batchRef`, then `packet` exposes only bounded course ordinals and safe official roots. Every path must be recorded with `claim-path` before that file is edited. A path claim is rejected when another active batch already owns the same file or provider/parser scope, so concurrent responders cannot silently modify the same reusable implementation. The database lease token and row ids never leave the command implementation.

When a durably closed `RETRYABLE_FAILED` batch is due and coordination requires that exact retry, pass its private reference with `claim --retry-batch-ref`. The claim fails closed unless every prior entry is still `RETRY_SCHEDULED`, currently due, unowned, and unchanged in incident, course, cycle, provider family, and failure fingerprint, and no outside critical real-demand candidate is due. It never falls back to unrelated queue work, and the private reference must not be copied into reports or logs.

For a multi-course source batch whose entries have different retry times, coordination may select exactly one immutable source-entry ordinal with `claim --retry-batch-ref <private-ref> --retry-ordinal <NN> --max-courses 1`. Source-entry ordinals use the persisted batch-entry order (`createdAt`, then the private row id as a tie-breaker); they are not course-name order and must never be accompanied by a row id or course name in task output. Exact-entry mode still requires the whole source batch to be a durably closed retryable batch with unique, latest `RETRY_SCHEDULED` entries, then revalidates the selected entry's current cycle, provider provenance, due time, demand, ownership, and source-entry relation inside the ordinary serializable claim fence. Unselected siblings need not be due. Any invalid ordinal or mismatch aborts without falling back to the normal queue.

The responder uses the transaction-scoped Postgres advisory lease `tee-time-spot:course-support-writer` only for short inspect/claim/recovery state transitions. The hourly loop uses its own `tee-time-spot:hourly-improvement-writer` lease. Up to three durable responder batches and unfinished responder `AutomationRun` rows may own different provider groups during their longer implementation intervals. A responder lease lasts 15 minutes and must be heartbeated while work continues. For an investigation expected to outlast one lease, start the bounded `heartbeat --watch` command in a separate process. It renews every four minutes by default, stops after 45 minutes by default, fails immediately if ownership is lost, and never changes the release fence.

An expired batch can be recovered only when branch, expected `HEAD`, owner-task provenance, committed paths, and dirty paths match the saved batch plan. A commit made before release heartbeat is recoverable only when the base is an ancestor and every committed path was already claimed. A different task cannot adopt dirty work. Unplanned paths, another responder writer, an active responder lease, or mismatched provenance require owner attention.

Recovery atomically transfers the batch and lease token to the recovering task. After `recover` reports success, continue that same batch directly through heartbeat, verification, and closeout; never claim a fresh batch. A later `inspect` supplies the current task identity and returns `resume_owned_work` only for that task's own healthy batch. Missing or mismatched task identity and another responder batch still fail closed as `deferred_busy`; hourly activity is outside the responder lane.

When an expired batch cannot be adopted because its checkout provenance moved, `recover` refreshes `origin/main` and may safely requeue the batch instead of blocking the lane indefinitely, but only when the checkout is clean, no changed candidate release was published or deployed, and every batch entry is still pending or stale. An unchanged runtime may persist the batch base SHA as its release SHA and deployment timestamp; those records prove baseline verification, not a published remediation. A recorded recheck dispatch is eligible only after every batch entry has been durably classified as stale evidence; pending or mixed dispatch evidence still fails closed. A persisted candidate SHA is not by itself a published release. The transition does not adopt, reset, publish, or delete the local branch. It atomically closes the abandoned batch as retryable, releases each incident, records a short future retry, and closes the unfinished automation run. Any dirty checkout, changed published or deployed release, pending dispatch activity, terminal evidence, human decision, or concurrent state change still fails closed for owner attention.

## Search Execution And Fresh Proof

Each search check uses a separate 15-minute row-token lease on `TeeSearch`. Network calls happen outside a database transaction. Every provider request, including official-site discovery follow-ups, claims the destination family's distributed slot; multi-request adapter steps run sequentially. Provider work is capped globally at two requests and at one request per provider family. Completion is a compare-and-set on search id, `scheduleVersion`, and lease token, so a stale Workflow cannot overwrite a newer edit, pause, resume, or explicit check.

Email uses a generation-scoped `SearchEmailDelivery` outbox. Recipient/intent changes, pause, stop, and delete serialize on the same search row as delivery claims, suppress unsent older generations, and return a retryable conflict while an irreversible send is finishing. Stable per-delivery idempotency keys and immutable render snapshots close the prior send/mark crash gap. Owner success finalizes the customer-visible match/status immediately; each failed additional recipient retains independent retry state and cannot block a newer owner alert.

A single provider failure stays quiet while the two-minute retry runs. A confirmed outage sends one customer-safe notice saying the provider's public service is not responding, the alert remains active, and Tee Time Spot will keep retrying. Confirmation may come from two failures on the course or a matching provider-family failure on another course. When a fresh public check succeeds, recovery email goes only to recipients reached by the outage notice; if that check also finds matching times, the recovery message includes them and replaces a separate match email.

If work is requested while the row lease is busy, `recheckRequestedAt` persists that fact. The current owner consumes it during compare-and-set completion and schedules the follow-up immediately. Expired `CHECKING` and `QUEUED` states remain eligible for recovery.

Workflow completion also preserves the earliest durable email retry. If a known course-local booking release occurs while a multi-course check is still running, the successor starts immediately instead of waiting for the base cadence.

Every new `CourseProbe` records `runtimeVersion`, normally the deployed Git commit SHA. An unchanged probe may be reused only within the same runtime version. A code remediation is verified only when all of these are true:

- the responder persists the candidate release SHA immediately after commit, before deployment;
- deployment proof is attached only to that same persisted SHA;
- the newest course probe is different from the pre-claim probe;
- it was observed no earlier than the deployment/batch verification boundary;
- its `runtimeVersion` exactly matches the claimed release SHA; and
- its outcome is `MATCH_FOUND` or `NO_MATCH`.

When an incident no longer has any active future search for its course, the five-minute deployed recovery cron may run one standalone `CourseSupportVerificationRequest` for the claimed release. Each request has a durable 12-minute deadline. Success within that window is consumed as release proof; a later unrelated transient failure is recorded as a new monitoring event instead of reopening the completed release verification. A retry that cannot start before the deadline becomes stale and the batch closes with a precise retryable outcome instead of waiting indefinitely. This covers both engineering-only synthetic provenance and historical real-demand incidents after their golfer searches end; `engineeringOnly` remains unchanged so notification and provenance history stay accurate. This is not a synthetic customer search: the verification request stores no user, recipient, search, match, slot, booking URL, or delivery payload, and the detached path cannot create customer-scoped rows or send email. Provider discovery may still update reusable canonical course metadata and append source-backed discovery evidence, including an official booking URL. It uses the same shared provider dispatcher and provider-family lease with one player and a bounded course-local daylight window. The request rechecks exact release/runtime ownership, incident state, current active demand, and the provider snapshot before discovery, before adapter I/O, at completion, and again when proof is consumed. Any active future course/search pair invalidates detached proof so the normal golfer Workflow remains authoritative.

Detached success is accepted only for an exact-release `MATCH_FOUND` or `NO_MATCH` with `providerExecution=true`, a safe provider response, an unchanged provider fingerprint, and evidence newer than deployment, dispatch, and the incident's newest failure. It proves reusable provider readiness only; it never means a golfer received an alert. Unsupported metadata, account/CAPTCHA/queue barriers, unsafe booking destinations, and provider failures remain honest non-success evidence.

The first post-deploy `verify` may create a detached request and report only aggregate `detachedVerification.pendingCount` plus `detachedVerification.rerunNeeded`. When a rerun is needed, do not close the batch: keep the lease alive, wait for the deployed five-minute recovery cron, and run `verify` again. Closeout fails closed while the exact-release request is queued or checking, when a success has not yet been consumed, or when current retry/cooldown evidence has not been copied into the batch proof. This prevents an immediate closeout from cancelling the check or discarding a provider `Retry-After`.

If `origin/main` advances concurrently before the first responder release is fenced, rebase the clean responder commit onto that fetched main. After a release is fenced, integrate fetched `origin/main` while preserving the persisted release as an ancestor of the new HEAD. The fence trusts intervening commits already present on `origin/main`; the remaining responder delta from that exact remote SHA to the candidate must be nonempty and contain only claimed paths. Once the exact release is durably fenced, later verification does not reinterpret already-persisted paths merely because `origin/main` advanced to that release. If the same owned batch needs a follow-up release after an earlier deployment, the release fence may advance only during an explicit `VERIFYING` heartbeat. The checkout must be clean on the claimed branch, the persisted release must be an ancestor of the new HEAD, and the responder delta after any trusted concurrent main advance must contain only already planned paths. The transition preserves the prior deployment, recheck, and ordinal verification evidence in bounded `releaseHistory`, then atomically clears the current deployment/recheck fields and non-human machine proof. Verification cannot continue until the descendant SHA has its own deployment proof. Recovery may preserve a clean planned descendant only for the original owner task; it never advances the release by itself.

An older success, a local check, a Workflow id by itself, or a new probe from a different runtime cannot resolve the incident. A persisted final classification uses the classification-only path and does not pretend an adapter ran.

## Vercel Queue Fallback

Vercel Queue is a bounded deployed-runtime fallback for starting a Workflow when an immediate start fails. The configured trigger is the beta `queue/v2beta` surface, so it is not the source of truth and is not a second scheduler. Local course-remediation runs persist `QUEUED` state in Postgres for the deployed recovery cron instead of publishing through a development-scoped queue.

- Topic: `tee-time-spot-search-schedule`.
- Private push consumer: `/api/queues/search-schedule`.
- Delivery is at least once; the consumer accepts only the exact active `scheduleVersion` and compare-and-set attaches the Workflow run.
- The message has exactly `searchId`, `scheduleVersion`, and trigger (`START_FAILED` or `COURSE_REMEDIATED`). It contains no email address, alias tag, course/provider details, booking URL, signed link, or credentials.
- The producer uses a SHA-256-derived idempotency key rather than exposing the search id in that key.
- Retention is 24 hours. Consumer concurrency is capped at 2, callback visibility is 120 seconds, and the configured trigger retry delay is 30 seconds; transient failures use bounded backoff and invalid messages are acknowledged as poison messages.
- A remediation increments and queues each affected active search once. Hashed affected-search references, dispatch counts, scheduler state, and fresh check timestamps are persisted; closeout waits until all affected searches have real scheduler and provider evidence.
- The five-minute deployed recovery cron picks up a locally queued row with no Workflow after a two-minute guard period. Attached queued runs and other overdue states retain the ten-minute safety threshold. If deployed Queue delivery fails, Postgres remains recoverable and the cron can restart the schedule; no local process directly starts Workflow. Never delete saved demand because a Workflow, queue, or email attempt failed.

Keep the queue payload minimal. Do not log raw message bodies, database ids, workflow ids, recipient data, signed URLs, or provider tokens in responder summaries.

## Retry And Closeout

The normal provider retry ladder is approximately 15 minutes, 1 hour, 6 hours, then 24 hours, with deterministic 0.9-to-1.1 jitter. A provider `Retry-After` for rate limiting is honored between 1 minute and 24 hours. Retries persist `nextAttemptAt`. Repeated `SOURCE_MISSING` or `SOURCE_CONFLICT` evidence does not retry forever: after at least four verified attempts spanning at least 24 hours, it becomes `ENGINEERING_VERIFICATION_NEEDED` with `SOURCE_UNVERIFIED`; automation does not approve that final itself. The responder derives current real-demand count and earliest target date from live owner-scoped searches using each course's local calendar day instead of trusting a stale incident snapshot. New real demand promotes priority and makes a missed engineer-approved-final revalidation immediately recoverable by the watchdog.

An engineering-only incident may use the provider retry ladder after its first task closes, but it may remain `AUTO_INVESTIGATING` for at most 30 minutes. At that deadline it must have working monitoring, a verified terminal limitation, or a recorded `ENGINEERING_VERIFICATION_NEEDED` state containing the completed attempts and exact next action.

Closeout independently derives per-course and batch outcomes from persisted evidence:

- `success`: every incident has fresh runnable proof.
- `classification_only`: every incident has a final durable non-runnable disposition.
- `partial`: at least one incident resolved or received a final disposition and another remains retryable.
- `retryable_failed`: all unresolved work has a persisted future retry.
- `needs_human`: a concrete unavoidable action remains after safe automated work.

Terminal closeout additionally requires immutable proof snapshots, an unchanged incident cycle/version, complete recheck dispatch, a healthy workflow (or a later golfer stop) for every affected search, and a fresh post-dispatch check. Authentication, challenge, source, reader, and not-found restrictions require an explicit visible human decision before becoming final. Engineering-only incidents may enter human review, but they never send course-support email unless real customer demand is active.

Privacy, delivery, unsafe-provider, migration, deployment, production-verification, authentication, environment, Git, command, recovery, and repeated-SLA failures are never routine closeouts.

## Task Retention Policy

The responder never performs sidebar cleanup. A separate low-priority maintenance automation archives old completed responder tasks only after activity and durable-closeout guards pass. Cleanup failure affects sidebar hygiene only and must never extend a batch lease, block provider work, or change production state.

## Operator Commands

Run commands through the environment that owns the target database. Structured output is redacted and should still be treated as internal operational evidence.

```powershell
# Inspect first. No branch or provider research is needed for no_due_work.
npm run automation:course-support -- inspect

# Aggregate provider coverage and leverage dashboard. No course names, ids,
# recipients, URLs, or workflow identifiers are returned.
npm run automation:course-support -- coverage

# Claim a clean, current task branch, inspect ordinal evidence, then claim paths before edits.
npm run automation:course-support -- claim --max-courses 5
npm run automation:course-support -- packet --batch-ref <batch-ref>
npm run automation:course-support -- claim-path --batch-ref <batch-ref> --path src/lib/example.ts

# Keep a claimed batch alive. Immediately fence the candidate commit before deploy.
npm run automation:course-support -- heartbeat --batch-ref <batch-ref> --status IMPLEMENTING
npm run automation:course-support -- heartbeat --batch-ref <batch-ref> --status IMPLEMENTING --watch --max-minutes 45
npm run automation:course-support -- heartbeat --batch-ref <batch-ref> --status VERIFYING --release-sha <git-sha>

# Diagnose browser classification before recording evidence or releasing code.
# The trace contains only target ordinals, coarse booleans, and reason codes.
# Provider concurrency coordination remains active, but the dry-run does not
# create an AutomationRun or persist discovery, course, incident, or probe data.
npm run automation:browser-probe -- --dry-run --trace-json --course-name "<exact course name>" --limit 1

# Gate a classification-only release on the expected pre-mutation result.
npm run automation:browser-probe -- --dry-run --trace-json --course-name "<exact course name>" --limit 1 --expect-disposition MANUAL_FINAL

# When investigation justifies no code change, verify the shared adapter on the
# exact production deployment of the clean claimed base SHA. This is permitted
# only before paths or a release have been recorded.
npm run automation:course-support -- heartbeat --batch-ref <batch-ref> --status VERIFYING --current-runtime
npm run deployment:wait -- --sha <claimed-base-sha>
npm run automation:course-support -- verify --batch-ref <batch-ref> --current-runtime --deployed-at <iso-timestamp>

# Verify classification evidence, or first run deployment:wait and then verify fresh probes from the exact deployed SHA.
npm run automation:course-support -- verify --batch-ref <batch-ref>
npm run deployment:wait -- --sha <git-sha>
npm run automation:course-support -- verify --batch-ref <batch-ref> --release-sha <git-sha> --deployed-at <iso-timestamp>

# If detachedVerification.rerunNeeded is true, heartbeat, wait for the deployed
# recovery cron, and rerun verify before closeout.
npm run automation:course-support -- heartbeat --batch-ref <batch-ref> --status VERIFYING
npm run automation:course-support -- verify --batch-ref <batch-ref>

# Record a concrete unavoidable external action after the safe playbook is exhausted.
npm run automation:course-support -- mark-needs-human --batch-ref <batch-ref> --ordinal 01 --evidence "<bounded evidence>" --next-action "<one exact action>"

# Close from independently derived persisted evidence.
npm run automation:course-support -- closeout --batch-ref <batch-ref> --outcome success

# Recovery is explicit and provenance checked. When inspect returns
# recovery_required, make no provider, implementation, or deployment change;
# call recover once from the persistent responder checkout. It may adopt only
# matching clean work and rejects dirty, unplanned, or committed foreign work.
# Continue a successfully recovered batch directly and stop on rejection.
npm run automation:course-support -- recover --batch-ref <batch-ref>

# Responder-state backfill is dry-run by default. Existing synthetic cohorts first
# use the bounded cohort backfill shown in the rollout section.
npm run automation:course-support -- backfill
npm run automation:course-support -- backfill --apply

# Course lifecycle and operator actions are dry-run by default.
npm run automation:course-monitoring -- inspect --course-ref <course-ref>
npm run automation:course-monitoring -- backfill
npm run automation:course-monitoring -- correct-link --course-ref <course-ref> --status-revision <n> --incident-cycle <n> --incident-revision <n> --booking-url <https-url> --evidence-url <https-url> --note "<bounded note>" --idempotency-key <key>
npm run automation:course-monitoring -- recheck --course-ref <course-ref> --status-revision <n> --incident-cycle <n> --incident-revision <n> --note "<bounded note>" --idempotency-key <key>
npm run automation:course-monitoring -- approve-final --course-ref <course-ref> --status-revision <n> --incident-cycle <n> --incident-revision <n> --reason <reason> --evidence-url <https-url> --note "<bounded note>" --idempotency-key <key>
npm run automation:course-monitoring -- reopen --course-ref <course-ref> --status-revision <n> --incident-cycle <n> --incident-revision <n> --evidence-url <https-url> --note "<bounded note>" --idempotency-key <key>

# Add --apply and a non-email --actor-id only after reviewing the dry run.
```

Coverage status is evidence-based: `MONITORED` requires a current successful probe
or a newer `MONITORING_RESTORED` incident resolution. `SUPPORTED_READY` means the
provider configuration is runnable but no course check has run yet.
`SUPPORTED_DEGRADED` is reserved for an open support incident or an unresolved
latest failed probe. Current authentication, challenge, or queue barriers are
reported separately as `TECHNICAL_CONSTRAINT` once verified and classified.

Do not paste task ids, batch references, database ids, or workflow ids into customer-visible reports. The CLI accepts `--owner-thread` only when `CODEX_THREAD_ID` is unavailable and the real current task id is known.

## Migration And Rollout

The lifecycle schema change is additive: it adds monitoring state/events, incident public references, confirmation/deadline/reminder and decision metadata, reader-candidate classifications, and the human-verified technical resolution. Apply it before application code. Validate migration and dry-run/apply backfill on an isolated Neon branch first, use the direct production Neon connection for `prisma migrate deploy`, inspect migration status, and never print the resolved URL.

Roll out in this order:

1. Validate focused tests, the full suite, lint, build, UI smoke, and `git diff --check`.
2. Apply the additive migration in production.
3. Run `automation:course-monitoring -- backfill`, record aggregate counts, then repeat with `--apply` and verify matching readback counts. The command imports one baseline event per course, preserves manual/identity/human-approved finals, confirms existing open work, and reopens only AI-final technical rows.
4. Push the verified commit to `origin/main`, wait for the exact Git-created Vercel deployment, and verify the queue consumer/configuration, production routes, schedules, and logs without running extra provider probes.
5. Run three responder cycles in inspect-only canary mode. Then enable claims at the default batch size of 5.
6. Keep the batch size at 5 for at least three clean completed batches. Raise it only deliberately, and never above 20.

Rollback is application-first when the additive columns remain harmless to the previous runtime. Do not reverse or destructively rewrite responder history. Pause claims, preserve incidents/batches, and retain the per-search Workflow, queue fallback, and daily safety-recovery path that protect saved demand.

## Safety Boundaries

- Use only official, public, signed-out, read-only provider surfaces. Never enter checkout, account, verification-code, CAPTCHA, waiting-room, or queue-gated flows; never bypass a block or rate limit.
- Treat account-required, CAPTCHA/queue, private/non-course identity, phone/walk-in, and unsupported providers as honest outcomes, not engineering successes. Provider or course policy text alone is not a monitoring outcome.
- Do not send course-support email for engineering-only synthetic incidents. Synthetic demand never outranks critical real demand.
- Do not expose recipients, alias addresses, signed stop links, provider tokens, raw provider responses, database ids, Workflow ids, or responder lease tokens.
- A course-level failure must not suppress checks or alerts for the golfer's other ranked courses.
- The golfer still books on the official site. The responder never books, holds, reserves, pays, or impersonates a golfer.
