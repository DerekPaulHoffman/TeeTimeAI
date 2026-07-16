# Course-Support Responder

The course-support responder is the dedicated engineering path for persistent `NEEDS_ADAPTER` and `FETCH_FAILED` outcomes. It runs every 10 minutes, groups reusable work, and either restores policy-safe monitoring or records a final evidence-backed disposition. It is separate from per-search scheduling and from the broad hourly product-improvement loop.

## Ownership And Cadence

- Vercel Workflows remain the scheduler for golfer searches. The responder does not poll tee sheets on a timer and does not replace a search workflow.
- The Codex automation `tee-time-spot-course-support-responder` begins every 10-minute task with `npm run automation:course-support -- inspect`.
- The responder runs from the already-approved dedicated checkout `C:\dev\TeeTimeAI-cohort-remediation`; the hourly loop remains in `C:\dev\TeeTimeAI-automation`. They must never share one mutable checkout. The database writer lease still serializes release ownership across both checkouts.
- A due batch contains one provider family and one failure fingerprint. The default claim is 5 courses; the command clamps all requests to 1 through 20.
- Batches prioritize near-date real-demand fetch failures, then other real demand, then non-engineering incidents, then engineering-only synthetic coverage. Aged engineering-only evidence receives bounded fairness when no critical real demand is waiting.
- The broad hourly product-improvement loop must exit `blocked_concurrent` before candidate selection when a responder batch is active or responder work is due. Course-support incidents are not portfolio candidates for that loop.

`CourseSupportIncident` is the durable per-course problem. `CourseSupportBatch` is the short-lived provider-family/fingerprint engineering claim. `CourseSupportBatchIncident` preserves the per-course pre-remediation evidence and final batch result.

## Provider Registry And Consumer Outcomes

Provider identity and runnable support come from `src/lib/automation/provider-capabilities.ts`, not scattered platform switches or optimistic URL guesses.

- Runnable families are `FOREUP`, `TEEITUP`, `CHRONOGOLF`, `CPS`, `CHELSEA`, `TEESNAP`, `GOLFBACK`, `WEBTRAC`, and `CLUB_CADDIE` when their required metadata validates.
- Recognized but non-runnable families are `GOLFNOW`, `WHOOSH`, and `TENFORE`. Recognition is not proof of monitoring support.
- Missing official source, missing metadata, unsupported family, authentication, rate limit, challenge, not-found, provider 5xx, timeout, network, schema, and unknown failures are classified separately.
- Contradictory persisted provider signals resolve to `SOURCE_CONFLICT`, which is deliberately non-runnable. No provider request may run until current official-source evidence reconciles the platform, booking URL, and metadata to one family.
- A failure fingerprint is a hash of the normalized provider family, failure class, operation, and HTTP status bucket. It contains no course name, recipient, URL, token, or raw error text.

Customer-facing readiness is derived independently from internal engineering state. The canonical dispositions are `MATCH_AVAILABLE`, `CHECKED_NO_MATCH`, `BOOKING_NOT_OPEN`, `DIRECT_SITE_ONLY`, `PHONE_OR_WALK_IN`, `ACCOUNT_REQUIRED`, `POLICY_BLOCKED`, `CAPTCHA_OR_QUEUE`, `PRIVATE_OR_INVALID`, `SOURCE_UNVERIFIED`, `RETRYING`, and `ENGINEERING`. Only `MATCH_AVAILABLE`, `CHECKED_NO_MATCH`, and `BOOKING_NOT_OPEN` count as effective monitored coverage.

A responder may resolve without a runnable adapter only when a current, sufficiently confident `CourseAutomationDiscovery` record cites an official HTTP(S) source and agrees with the persisted course state: booking is `PHONE_ONLY`, `CONTACT_COURSE`, or `WALK_IN`; or automation is blocked for `NO_ONLINE_BOOKING`, `AUTOMATION_PROHIBITED`, `ACCOUNT_REQUIRED`, or `CAPTCHA_OR_QUEUE`. A stale course snapshot, unsupported URL guess, or internally contradictory discovery is never a final disposition. Private/non-course identity still requires the separate exact-place review path. Terminal discovery or exact-review evidence must belong to the current incident cycle and agree with the reconciled course state; later repeats of the same unresolved observation do not invalidate that durable classification. Restored runnable monitoring remains stricter and must supersede the newest failure with fresh exact-runtime workflow proof.

## Claim, Lease, And Repository Safety

Claiming requires all of the following:

- a clean `automation/course-support-*` task branch;
- checked-out `HEAD` exactly equal to current `origin/main`;
- the real Codex task id from `CODEX_THREAD_ID` or `--owner-thread`;
- no active hourly writer or active responder batch.

Claim returns a redacted `batchRef`, then `packet` exposes only bounded course ordinals and safe official roots. Every path must be recorded with `claim-path` before that file is edited. The database lease token and row ids never leave the command implementation.

The responder and hourly loop share the transaction-scoped Postgres advisory lease `tee-time-spot:repository-writer` for inspect/claim/recovery state transitions. The durable batch and unfinished `AutomationRun` own the longer implementation interval. A responder lease lasts 15 minutes and must be heartbeated while work continues.

An expired batch can be recovered only when branch, expected `HEAD`, owner-task provenance, committed paths, and dirty paths match the saved batch plan. A commit made before release heartbeat is recoverable only when the base is an ancestor and every committed path was already claimed. A different task cannot adopt dirty work. Unplanned paths, another responder/hourly writer, an active lease, or mismatched provenance require owner attention.

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

If the same owned batch needs a follow-up release after an earlier deployment, the release fence may advance only during an explicit `VERIFYING` heartbeat. The checkout must be clean on the claimed branch, the persisted release must be an ancestor of the new HEAD, and both the cumulative and incremental diffs must contain only already planned paths. The transition preserves the prior deployment, recheck, and ordinal verification evidence in bounded `releaseHistory`, then atomically clears the current deployment/recheck fields and non-human machine proof. Verification cannot continue until the descendant SHA has its own deployment proof. Recovery may preserve a clean planned descendant only for the original owner task; it never advances the release by itself.

An older success, a local check, a Workflow id by itself, or a new probe from a different runtime cannot resolve the incident. A persisted final classification uses the classification-only path and does not pretend an adapter ran.

## Vercel Queue Fallback

Vercel Queue is a bounded fallback for starting a Workflow when the immediate start fails and for dispatching one fresh check after a course remediation. The configured trigger is the beta `queue/v2beta` surface, so it is not the source of truth and is not a second scheduler.

- Topic: `tee-time-spot-search-schedule`.
- Private push consumer: `/api/queues/search-schedule`.
- Delivery is at least once; the consumer accepts only the exact active `scheduleVersion` and compare-and-set attaches the Workflow run.
- The message has exactly `searchId`, `scheduleVersion`, and trigger (`START_FAILED` or `COURSE_REMEDIATED`). It contains no email address, alias tag, course/provider details, booking URL, signed link, or credentials.
- The producer uses a SHA-256-derived idempotency key rather than exposing the search id in that key.
- Retention is 24 hours. Consumer concurrency is capped at 2, callback visibility is 120 seconds, and the configured trigger retry delay is 30 seconds; transient failures use bounded backoff and invalid messages are acknowledged as poison messages.
- A remediation increments and queues each affected active search once. Hashed affected-search references, dispatch counts, scheduler state, and fresh check timestamps are persisted; closeout waits until all affected searches are accounted for.
- If queue delivery fails, same-version direct recovery is attempted. Postgres remains recoverable, the current durable Workflow caps its next wake to any due email retry, and the daily safety cron can restart an unusually orphaned schedule later. Never delete saved demand because a Workflow, queue, or email attempt failed.

Keep the queue payload minimal. Do not log raw message bodies, database ids, workflow ids, recipient data, signed URLs, or provider tokens in responder summaries.

## Retry And Closeout

The normal retry ladder is approximately 15 minutes, 1 hour, 6 hours, then 24 hours, with deterministic 0.9-to-1.1 jitter. A provider `Retry-After` for rate limiting is honored between 1 minute and 24 hours. Retries persist `nextAttemptAt`; a task must not archive a retryable failure without a future durable retry time.

Closeout independently derives per-course and batch outcomes from persisted evidence:

- `success`: every incident has fresh runnable proof.
- `classification_only`: every incident has a final durable non-runnable disposition.
- `partial`: at least one incident resolved or received a final disposition and another remains retryable.
- `retryable_failed`: all unresolved work has a persisted future retry.
- `needs_human`: a concrete unavoidable action remains after safe automated work.

Terminal closeout additionally requires immutable proof snapshots, an unchanged incident cycle/version, complete recheck dispatch, a healthy workflow (or a later golfer stop) for every affected search, and a fresh post-dispatch check. Authentication, challenge, and not-found restrictions cannot use the transient retry ladder; they require a current final classification or an explicit visible human action. Engineering-only incidents cannot be escalated to the owner.

Privacy, delivery, unsafe-provider, migration, deployment, production-verification, authentication, environment, Git, command, recovery, and repeated-SLA failures are never routine closeouts.

## Task Auto-Archive Policy

The automation may archive its own Codex task only after the command reports a durable closeout and `threadDisposition: ARCHIVE`.

Routine archived outcomes are `no_due_work`, a durably recorded `deferred_busy`, `success`, `classification_only`, `partial`, and `retryable_failed` with a future `nextAttemptAt`. Archive only after the durable database transition succeeds; an archive API failure does not change batch state.

Keep the task visible for work in progress (`ready`), recovery required, missing durable closeout, `needs_human`, privacy or wrong-recipient evidence, delivery failures, unsafe-provider behavior, migration/deploy/production-verification failure, authentication/environment/Git blockers, command failures, or repeated SLA failure. Other automations and interactive tasks are not auto-archived by this policy.

## Operator Commands

Run commands through the environment that owns the target database. Structured output is redacted and should still be treated as internal operational evidence.

```powershell
# Inspect first. No branch or provider research is needed for no_due_work.
npm run automation:course-support -- inspect

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

# Only real-demand incidents may record a concrete unavoidable external action.
npm run automation:course-support -- mark-needs-human --batch-ref <batch-ref> --ordinal 01 --evidence "<bounded evidence>" --next-action "<one exact action>"

# Close from independently derived persisted evidence.
npm run automation:course-support -- closeout --batch-ref <batch-ref> --outcome success

# Recovery is explicit and provenance checked.
npm run automation:course-support -- recover --batch-ref <batch-ref>

# Responder-state backfill is dry-run by default. Existing synthetic cohorts first
# use the bounded cohort backfill shown in the rollout section.
npm run automation:course-support -- backfill
npm run automation:course-support -- backfill --apply
```

Do not paste task ids, batch references, database ids, or workflow ids into customer-visible reports. The CLI accepts `--owner-thread` only when `CODEX_THREAD_ID` is unavailable and the real current task id is known.

## Migration And Rollout

The dispatcher schema change is additive: it adds provider-family/failure/retry fields, search lease/recheck and alert-generation fields, probe runtime versions, the generation-scoped email outbox, provider request leases, and versioned batch/proof tables and indexes. Apply the production migration before deploying application code that depends on it. Use the direct production Neon connection for `prisma migrate deploy`, inspect migration status, and never print the resolved URL.

Roll out in this order:

1. Validate focused tests, the full suite, lint, build, UI smoke, and `git diff --check`.
2. Apply the additive migration in production.
3. Seed missing cohort incidents from persisted newest outcomes with `npm run automation:backfill-synthetic-remediation -- --email-tag +tts-stress-20260714-`, inspect only aggregate/redacted output, then repeat with `--apply`. Next run `automation:course-support -- backfill` without and then with `--apply`. Both commands derive state from existing rows and make no provider request.
4. Push the verified commit to `origin/main`, wait for the exact Git-created Vercel deployment, and verify the queue consumer/configuration, production routes, schedules, and logs without running extra provider probes.
5. Run three responder cycles in inspect-only canary mode. Then enable claims at the default batch size of 5.
6. Keep the batch size at 5 for at least three clean completed batches. Raise it only deliberately, and never above 20.

Rollback is application-first when the additive columns remain harmless to the previous runtime. Do not reverse or destructively rewrite responder history. Pause claims, preserve incidents/batches, and retain the per-search Workflow, queue fallback, and daily safety-recovery path that protect saved demand.

## Safety Boundaries

- Use only official, public, policy-safe provider surfaces. Never enter checkout, account, verification-code, CAPTCHA, waiting-room, or queue-gated flows; never bypass a block or rate limit.
- Treat account-required, CAPTCHA/queue, prohibited automation, private/non-course identity, phone/walk-in, and unsupported providers as honest outcomes, not engineering successes.
- Do not send course-support email for engineering-only synthetic incidents. Synthetic demand never outranks critical real demand.
- Do not expose recipients, alias addresses, signed stop links, provider tokens, raw provider responses, database ids, Workflow ids, or responder lease tokens.
- A course-level failure must not suppress checks or alerts for the golfer's other ranked courses.
- The golfer still books on the official site. The responder never books, holds, reserves, pays, or impersonates a golfer.
