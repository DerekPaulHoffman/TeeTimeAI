# Course-Support Responder

The course-support responder is the dedicated engineering path for persistent `NEEDS_ADAPTER` and `FETCH_FAILED` outcomes. It checks for real demand every 10 minutes, limits non-customer engineering work to one hourly sweep, groups reusable work, and either restores public read-only monitoring or records a final evidence-backed technical-access/contact/identity/source disposition. It is separate from per-search scheduling and from the broad product-improvement loop.

## Ownership And Cadence

- Vercel Workflows remain the scheduler for golfer searches. The responder does not poll tee sheets on a timer and does not replace a search workflow.
- The Codex automation `tee-time-spot-course-support-responder` begins every 10-minute task with `npm run automation:course-support -- inspect`.
- The responder runs from the already-approved dedicated checkout `C:\dev\TeeTimeAi-CourseSupportResponder`; the bounded product-improvement loop remains in `C:\dev\TeeTimeAI-automation`. They must never share one mutable checkout. The database writer lease still serializes release ownership across both checkouts.
- A due batch contains one provider family and one failure fingerprint. The default claim is 5 courses; the command clamps all requests to 1 through 20.
- Batches prioritize near-date active real-demand fetch failures, then other active real demand, then historical non-engineering incidents whose searches have ended, then engineering-only synthetic coverage. Aged engineering-only evidence receives bounded fairness when no critical real demand is waiting.
- Any active real demand may claim on every 10-minute run. When no active real demand is due, `inspect` and `claim` enforce the first ten UTC minutes as the single hourly engineering sweep; other runs close as `deferred_engineering_cadence` without provider, Git, or database mutation beyond the routine observation.
- The broad product-improvement loop uses an independent writer lane and may proceed while a responder batch is active or requires recovery. Responder state remains informational there, and course-support incidents are never portfolio candidates for that loop.

`CourseSupportIncident` is the durable per-course problem. `CourseSupportBatch` is the short-lived provider-family/fingerprint engineering claim. `CourseSupportBatchIncident` preserves the per-course pre-remediation evidence and final batch result.

## Provider Registry And Consumer Outcomes

Provider identity and runnable support come from `src/lib/automation/provider-capabilities.ts`, not scattered platform switches or optimistic URL guesses.

- Runnable families are `FOREUP`, `TEEITUP`, `CHRONOGOLF`, `CPS`, `CHELSEA`, `TEESNAP`, `GOLFBACK`, `WEBTRAC`, and `CLUB_CADDIE` when their required metadata validates.
- Recognized but non-runnable families are `EZLINKS`, `GOLFNOW`, `WHOOSH`, and `TENFORE`. Recognition is not proof of monitoring support.
- Missing official source, missing metadata, unsupported family, authentication, rate limit, challenge, not-found, provider 5xx, timeout, network, schema, and unknown failures are classified separately.
- Contradictory persisted provider signals resolve to `SOURCE_CONFLICT`, which is deliberately non-runnable. No provider request may run until current official-source evidence reconciles the platform, booking URL, and metadata to one family.
- A failure fingerprint is a hash of the normalized provider family, failure class, operation, and HTTP status bucket. It contains no course name, recipient, URL, token, or raw error text.

Customer-facing readiness is derived independently from internal engineering state. The canonical dispositions are `MATCH_AVAILABLE`, `CHECKED_NO_MATCH`, `BOOKING_NOT_OPEN`, `DIRECT_SITE_ONLY`, `PHONE_OR_WALK_IN`, `ACCOUNT_REQUIRED`, `POLICY_BLOCKED`, `CAPTCHA_OR_QUEUE`, `PRIVATE_OR_INVALID`, `SOURCE_UNVERIFIED`, `RETRYING`, and `ENGINEERING`. Only `MATCH_AVAILABLE`, `CHECKED_NO_MATCH`, and `BOOKING_NOT_OPEN` count as effective monitored coverage.

A responder may resolve without a runnable adapter only when a current, sufficiently confident `CourseAutomationDiscovery` record cites an official HTTP(S) source and agrees with the persisted course state: booking is `PHONE_ONLY`, `CONTACT_COURSE`, or `WALK_IN`; or current technical access is blocked for `NO_ONLINE_BOOKING`, `ACCOUNT_REQUIRED`, or `CAPTCHA_OR_QUEUE`. `AUTOMATION_PROHIBITED` and policy text are legacy evidence, never terminal monitoring dispositions. A stale course snapshot, unsupported URL guess, or internally contradictory discovery is never a final disposition. Private/non-course identity still requires the separate exact-place review path; when that review is applied during an active responder claim, verification accepts it only if the active exact review is newer than the latest incident evidence and the persisted course is reconciled to non-public, blocked state. Terminal discovery or exact-review evidence must belong to the current incident cycle and agree with the reconciled course state; later repeats of the same unresolved observation do not invalidate that durable classification. Restored runnable monitoring remains stricter and must supersede the newest failure with fresh exact-runtime workflow proof.

## Claim, Lease, And Repository Safety

Claiming requires all of the following:

- a clean `automation/course-support-*` task branch;
- checked-out `HEAD` exactly equal to current `origin/main`;
- the real Codex task id from `CODEX_THREAD_ID` or `--owner-thread`;
- no active responder batch in the course-support lane.

Claim returns a redacted `batchRef`, then `packet` exposes only bounded course ordinals and safe official roots. Every path must be recorded with `claim-path` before that file is edited. The database lease token and row ids never leave the command implementation.

When a durably closed `RETRYABLE_FAILED` batch is due and coordination requires that exact retry, pass its private reference with `claim --retry-batch-ref`. The claim fails closed unless every prior entry is still `RETRY_SCHEDULED`, currently due, unowned, and unchanged in incident, course, cycle, provider family, and failure fingerprint, and no outside critical real-demand candidate is due. It never falls back to unrelated queue work, and the private reference must not be copied into reports or logs.

For a multi-course source batch whose entries have different retry times, coordination may select exactly one immutable source-entry ordinal with `claim --retry-batch-ref <private-ref> --retry-ordinal <NN> --max-courses 1`. Source-entry ordinals use the persisted batch-entry order (`createdAt`, then the private row id as a tie-breaker); they are not course-name order and must never be accompanied by a row id or course name in task output. Exact-entry mode still requires the whole source batch to be a durably closed retryable batch with unique, latest `RETRY_SCHEDULED` entries, then revalidates the selected entry's current cycle, provider provenance, due time, demand, ownership, and source-entry relation inside the ordinary serializable claim fence. Unselected siblings need not be due. Any invalid ordinal or mismatch aborts without falling back to the normal queue.

The responder uses the transaction-scoped Postgres advisory lease `tee-time-spot:course-support-writer` for inspect/claim/recovery state transitions. The hourly loop uses its own `tee-time-spot:hourly-improvement-writer` lease. The durable responder batch and unfinished responder `AutomationRun` own the longer responder implementation interval. A responder lease lasts 15 minutes and must be heartbeated while work continues.

An expired batch can be recovered only when branch, expected `HEAD`, owner-task provenance, committed paths, and dirty paths match the saved batch plan. A commit made before release heartbeat is recoverable only when the base is an ancestor and every committed path was already claimed. A different task cannot adopt dirty work. Unplanned paths, another responder writer, an active responder lease, or mismatched provenance require owner attention.

Recovery atomically transfers the batch and lease token to the recovering task. After `recover` reports success, continue that same batch directly through heartbeat, verification, and closeout; never claim a fresh batch. A later `inspect` supplies the current task identity and returns `resume_owned_work` only for that task's own healthy batch. Missing or mismatched task identity and another responder batch still fail closed as `deferred_busy`; hourly activity is outside the responder lane.

## Search Execution And Fresh Proof

Each search check uses a separate 15-minute row-token lease on `TeeSearch`. Network calls happen outside a database transaction. Every provider request, including official-site discovery follow-ups, claims the destination family's distributed slot; multi-request adapter steps run sequentially. Provider work is capped globally at two requests and at one request per provider family. Completion is a compare-and-set on search id, `scheduleVersion`, and lease token, so a stale Workflow cannot overwrite a newer edit, pause, resume, or explicit check.

Email uses a generation-scoped `SearchEmailDelivery` outbox. Recipient/intent changes, pause, stop, and delete serialize on the same search row as delivery claims, suppress unsent older generations, and return a retryable conflict while an irreversible send is finishing. Stable per-delivery idempotency keys and immutable render snapshots close the prior send/mark crash gap. Owner success finalizes the customer-visible match/status immediately; each failed additional recipient retains independent retry state and cannot block a newer owner alert.

If work is requested while the row lease is busy, `recheckRequestedAt` persists that fact. The current owner consumes it during compare-and-set completion and schedules the follow-up immediately. Expired `CHECKING` and `QUEUED` states remain eligible for recovery.

Workflow completion also preserves the earliest durable email retry. If a known course-local booking release occurs while a multi-course check is still running, the successor starts immediately instead of waiting for the base cadence.

Every new `CourseProbe` records `runtimeVersion`, normally the deployed Git commit SHA. An unchanged probe may be reused only within the same runtime version. A code remediation is verified only when all of these are true:

- the responder persists the candidate release SHA immediately after commit, before deployment;
- deployment proof is attached only to that same persisted SHA;
- the newest course probe is different from the pre-claim probe;
- it was observed no earlier than the deployment/batch verification boundary;
- its `runtimeVersion` exactly matches the claimed release SHA; and
- its outcome is `MATCH_FOUND` or `NO_MATCH`.

When an incident no longer has any active future search for its course, the five-minute deployed recovery cron may run one standalone `CourseSupportVerificationRequest` for the claimed release. This covers both engineering-only synthetic provenance and historical real-demand incidents after their golfer searches end; `engineeringOnly` remains unchanged so notification and provenance history stay accurate. This is not a synthetic customer search: the verification request stores no user, recipient, search, match, slot, booking URL, or delivery payload, and the detached path cannot create customer-scoped rows or send email. Provider discovery may still update reusable canonical course metadata and append source-backed discovery evidence, including an official booking URL. It uses the same shared provider dispatcher and provider-family lease with one player and a bounded course-local daylight window. The request rechecks exact release/runtime ownership, incident state, current active demand, and the provider snapshot before discovery, before adapter I/O, at completion, and again when proof is consumed. Any active future course/search pair invalidates detached proof so the normal golfer Workflow remains authoritative.

Detached success is accepted only for an exact-release `MATCH_FOUND` or `NO_MATCH` with `providerExecution=true`, a safe provider response, an unchanged provider fingerprint, and evidence newer than deployment, dispatch, and the incident's newest failure. It proves reusable provider readiness only; it never means a golfer received an alert. Unsupported metadata, account/CAPTCHA/queue barriers, unsafe booking destinations, and provider failures remain honest non-success evidence.

The first post-deploy `verify` may create a detached request and report only aggregate `detachedVerification.pendingCount` plus `detachedVerification.rerunNeeded`. When a rerun is needed, do not close the batch: keep the lease alive, wait for the deployed five-minute recovery cron, and run `verify` again. Closeout fails closed while the exact-release request is queued or checking, when a success has not yet been consumed, or when current retry/cooldown evidence has not been copied into the batch proof. This prevents an immediate closeout from cancelling the check or discarding a provider `Retry-After`.

If the same owned batch needs a follow-up release after an earlier deployment, the release fence may advance only during an explicit `VERIFYING` heartbeat. The checkout must be clean on the claimed branch, the persisted release must be an ancestor of the new HEAD, and both the cumulative and incremental diffs must contain only already planned paths. The transition preserves the prior deployment, recheck, and ordinal verification evidence in bounded `releaseHistory`, then atomically clears the current deployment/recheck fields and non-human machine proof. Verification cannot continue until the descendant SHA has its own deployment proof. Recovery may preserve a clean planned descendant only for the original owner task; it never advances the release by itself.

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

The normal retry ladder is approximately 15 minutes, 1 hour, 6 hours, then 24 hours, with deterministic 0.9-to-1.1 jitter. A provider `Retry-After` for rate limiting is honored between 1 minute and 24 hours. Retries persist `nextAttemptAt`. Repeated `SOURCE_MISSING` or `SOURCE_CONFLICT` evidence does not retry forever: after at least four verified attempts spanning at least 24 hours, and only when no active real demand exists, the incident closes as `SOURCE_UNVERIFIED`. Matching synthetic evidence does not immediately reopen it; new real demand or changed provider evidence does. This is an honest lack-of-source result, not proof that monitoring is impossible. The responder derives current real-demand count and earliest target date from live owner-scoped searches using each course's local calendar day at inspection and claim time instead of trusting a stale incident snapshot. A historical real-demand incident keeps `engineeringOnly=false` after those searches end, but no longer outranks active demand and becomes eligible for no-email detached verification. When an unclaimed engineering-only incident gains real demand, it becomes immediately due unless the unchanged failure is rate-limited. Claimed work keeps its current ownership and proof fences.

Closeout independently derives per-course and batch outcomes from persisted evidence:

- `success`: every incident has fresh runnable proof.
- `classification_only`: every incident has a final durable non-runnable disposition.
- `partial`: at least one incident resolved or received a final disposition and another remains retryable.
- `retryable_failed`: all unresolved work has a persisted future retry.
- `needs_human`: a concrete unavoidable action remains after safe automated work.

Terminal closeout additionally requires immutable proof snapshots, an unchanged incident cycle/version, complete recheck dispatch, a healthy workflow (or a later golfer stop) for every affected search, and a fresh post-dispatch check. Authentication, challenge, and not-found restrictions cannot use the transient retry ladder; they require a current final classification or an explicit visible human action. Engineering-only incidents cannot be escalated to the owner.

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
npm run automation:course-support -- heartbeat --batch-ref <batch-ref> --status VERIFYING --release-sha <git-sha>

# Verify classification evidence, or first run deployment:wait and then verify fresh probes from the exact deployed SHA.
npm run automation:course-support -- verify --batch-ref <batch-ref>
npm run deployment:wait -- --sha <git-sha>
npm run automation:course-support -- verify --batch-ref <batch-ref> --release-sha <git-sha> --deployed-at <iso-timestamp>

# If detachedVerification.rerunNeeded is true, heartbeat, wait for the deployed
# recovery cron, and rerun verify before closeout.
npm run automation:course-support -- heartbeat --batch-ref <batch-ref> --status VERIFYING
npm run automation:course-support -- verify --batch-ref <batch-ref>

# Only real-demand incidents may record a concrete unavoidable external action.
npm run automation:course-support -- mark-needs-human --batch-ref <batch-ref> --ordinal 01 --evidence "<bounded evidence>" --next-action "<one exact action>"

# Close from independently derived persisted evidence.
npm run automation:course-support -- closeout --batch-ref <batch-ref> --outcome success

# Recovery is explicit and provenance checked. Continue the recovered batch
# directly; an owner-aware inspect may report resume_owned_work for this task.
npm run automation:course-support -- recover --batch-ref <batch-ref>

# Responder-state backfill is dry-run by default. Existing synthetic cohorts first
# use the bounded cohort backfill shown in the rollout section.
npm run automation:course-support -- backfill
npm run automation:course-support -- backfill --apply
```

Do not paste task ids, batch references, database ids, or workflow ids into customer-visible reports. The CLI accepts `--owner-thread` only when `CODEX_THREAD_ID` is unavailable and the real current task id is known.

## Migration And Rollout

The dispatcher schema change is additive: it adds provider-family/failure/retry fields, search lease/recheck and alert-generation fields, probe runtime versions, the generation-scoped email outbox, provider request leases, versioned batch/proof tables and indexes, and the isolated engineering-only provider-verification request table. Apply the production migration before deploying application code that depends on it. Use the direct production Neon connection for `prisma migrate deploy`, inspect migration status, and never print the resolved URL.

Roll out in this order:

1. Validate focused tests, the full suite, lint, build, UI smoke, and `git diff --check`.
2. Apply the additive migration in production.
3. Seed missing cohort incidents from persisted newest outcomes with `npm run automation:backfill-synthetic-remediation -- --email-tag +tts-stress-20260714-`, inspect only aggregate/redacted output, then repeat with `--apply`. Next run `automation:course-support -- backfill` without and then with `--apply`. Both commands derive state from existing rows and make no provider request.
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
