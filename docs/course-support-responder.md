# Course-Support Responder

The course-support responder is the dedicated engineering path for persistent `NEEDS_ADAPTER`, `FETCH_FAILED`, and reader-candidate outcomes. It follows one proof-driven playbook across alert checks, detached verification, and responder work. It either restores public read-only monitoring, records a current factual direct action, or keeps the alert active in an explicit human-review state. It is separate from per-search scheduling and from the broad product-improvement loop.

## Ownership And Cadence

- Vercel Workflows remain the scheduler for golfer searches. The responder does not poll tee sheets on a timer and does not replace a search workflow.
- The required automation configuration for `tee-time-spot-course-support-responder` is 24 hours a day, every 2 minutes. Each launch runs the stable preflight plus production inspection first and exits immediately for `no_due_work` or healthy `deferred_busy`; only actionable work loads the full responder contract and starts a long-lived Codex owner. Preflight owns the approved checkout pool: `C:\dev\TeeTimeAI-course-support-clean` is primary and `C:\dev\TeeTimeAI-responder-self-healing` is standby. Verify that configuration in the automation control plane; this document does not prove that the live automation has already been updated.
- The scheduled health-bearing entrypoint is `npm run automation:course-support -- inspect --scheduled-cycle`. Only a scheduled `inspect` may use `--scheduled-cycle`; manual `inspect`, `coverage`, `verify`, and other commands must not change worker health.
- Before production inspection, run the current responder preflight with `npm run automation:course-support:preflight -- --run`. It fetches current `origin/main`, preserves dirty or diverged checkouts for their owner, safely fast-forwards a clean approved checkout, refreshes dependencies only when the lockfile changed, and selects the primary or standby. It returns a structured setup requirement when neither approved checkout is safe. Do not create an unapproved replacement checkout merely because setup is required.
- The bounded product-improvement loop remains in `C:\dev\TeeTimeAI-automation`. It must not use the dispatch checkout or select course-support incidents.
- A due batch contains one provider family and one failure fingerprint. The default claim is 5 courses; the command clamps all requests to 1 through 20.
- Batches prioritize near-date active real-demand fetch failures, then other active real demand, then historical non-engineering incidents whose searches have ended, then engineering-only synthetic coverage. Aged engineering-only evidence receives bounded fairness when no critical real demand is waiting.
- Every 2-minute run prioritizes an expired owned recovery before unrelated due work, then the scheduled tasks may coordinate up to two unrelated provider/fingerprint groups. Each task owns only one batch and retains that ownership through its bounded verification watch. When inspection reports `recoveryContinuation.reinspectAfterRecovery=true`, finish the one authorized recovery, inspect once more, and use remaining capacity for the highest-priority unrelated due group; recovery must not consume the only scheduled opportunity while safe capacity remains. Each claim remains bounded to no more than five courses by default. Genuine provider/path conflicts remain serialized; unrelated groups may proceed together. Missed scheduler ticks must not be replayed as a burst: the next inspection observes current durable state and starts at most one new owner.
- Each task records its provider group and bounded course ordinals at claim time and must end with a durable batch closeout (`success`, `classification_only`, `partial`, `retryable_failed`, or `needs_human`) or one concrete visible blocker. Passing local tests is not a closeout: when production still cannot produce trustworthy evidence, the task records the observed provider failure, performs the best safe reusable fix or terminal classification available, and persists the exact next attempt or engineering action.
- The broad product-improvement loop uses an independent writer lane and may proceed while a responder batch is active or requires recovery. Responder state remains informational there, and course-support incidents are never portfolio candidates for that loop.

`CourseSupportIncident` is the durable per-course problem. `CourseSupportBatch` is the short-lived provider-family/fingerprint engineering claim. `CourseSupportBatchIncident` preserves the per-course pre-remediation evidence and final batch result.

## Ordered Attempt Playbook And Deadlines

Every new or materially changed course uses this exact stage order. A skipped stage must be recorded as not applicable; absence of an attempt is never proof that the playbook was exhausted.

1. `OFFICIAL_IDENTITY`: validate the current official identity and booking evidence. Exact authoritative evidence for private/non-course identity, phone or walk-in booking, or no online tee times may produce a factual direct-action result immediately.
2. `TYPED_ADAPTER`: run the existing validated typed provider adapter when its metadata is runnable.
3. `OFFICIAL_HTTP_DISCOVERY`: perform bounded official HTTP/config discovery when metadata is missing, stale, contradictory, or the adapter failed.
4. `HTTP_ADAPTER_RETRY`: retry the typed adapter with any newly validated metadata.
5. `RENDERED_BROWSER_DISCOVERY`: use ordinary Playwright discovery only when HTTP remains inconclusive. It may execute normal page JavaScript and wait passively for a bounded period.
6. `BROWSER_ADAPTER_RETRY`: retry the typed adapter with metadata learned from the rendered official page.
7. `LOCAL_READER`: queue the signed local Chrome reader only as the last automatic read path and only when a safe compatible capability exists.
8. `INDEPENDENT_CONFIRMATION`: when no prior path returned a successful availability read, independently confirm the factual result, technical observation, or remaining inconclusive state before closeout.

A fresh signed `LOCAL_READER` result that successfully returns the requested tee sheet, including a truthful zero-slot result, is direct current monitoring proof and may restore monitoring without another browser read. This is the same bounded success short-circuit used by an earlier runnable adapter. `NOT_APPLICABLE`, `PAGE_MISMATCH`, `READER_ERROR`, and terminal access-control results are not monitoring proof: they leave `INDEPENDENT_CONFIRMATION` pending for the responder's persisted ordinary browser stage. The detached verifier must never mark that stage `NOT_APPLICABLE` merely because the reader did not provide a technical reason.

The timing contract is measured from alert creation or a material-change revalidation:

- Start immediately and complete the first bounded retry by T+2 minutes.
- Claim browser discovery by T+10 minutes and normally finish it by about T+15.
- Give the last-resort local reader one five-minute bounded window. A completed `ACCESS_CHALLENGE`, `PAGE_MISMATCH`, or `READER_ERROR` is terminal evidence for that reader attempt and must never become `CHECK_PENDING` again.
- Finish independent confirmation by T+25 minutes when the paths remain applicable.
- By T+30 minutes, every unresolved course must have a truthful endpoint: effective monitoring, a factual direct action, or `NEEDS_HUMAN_REVIEW`. A missing stage, unavailable tool, expired job, or stalled automation becomes human review with an automation-stalled reason; a timer by itself never proves playbook exhaustion or technical finality.

The nullable, versioned `CourseSupportIncident.attemptLedger` stores the redacted stage, applicability, transition, attempt count, timestamps, normalized failure class/fingerprint, and runtime version for the current incident cycle. Every transition is also mirrored into append-only `CourseMonitoringEvent` history. It must not contain course names, URLs, recipients, database identifiers, provider payloads, or raw errors. Legacy incidents with no ledger are unexhausted and must be requeued rather than inferred complete.

`isAutomationPlaybookExhausted()` is the common proof gate for responder `mark-needs-human`, automatic technical finality, and operator approval. At the T+30 watchdog deadline it distinguishes proof-backed exhaustion from an incomplete/stalled playbook: the latter still enters human review under `AUTOMATION_STALLED`, but is never described as exhausted. A technical final additionally requires a terminal local-reader observation plus a matching independent current observation from another safe path. If no safe local-reader capability exists, the truthful endpoint is human review, not an automatic technical final.

## Provider Registry And Consumer Outcomes

Provider identity and runnable support come from `src/lib/automation/provider-capabilities.ts`, not scattered platform switches or optimistic URL guesses.

- Runnable families are `FOREUP`, `TEEITUP`, `CHRONOGOLF`, `CPS`, `CHELSEA`, `TEESNAP`, `GOLFBACK`, `WEBTRAC`, `CLUB_CADDIE`, and `WHOOSH` when their required metadata validates. WHOOSH reads only signed-out `GOLF_COURSE` facilities; driving-range and other activity inventory is rejected.
- `EZLINKS` remains non-runnable from the server dispatcher because its public search is challenge-protected, but safe one-label tenant pages may run through the compatible rendered local reader. `GOLFNOW` remains recognized but non-runnable. `TENFORE` uses its rendered local reader. Recognition alone is not proof of monitoring support.
- Missing official source, missing metadata, unsupported family, authentication, rate limit, challenge, not-found, provider 5xx, timeout, network, schema, and unknown failures are classified separately.
- Contradictory persisted provider signals resolve to `SOURCE_CONFLICT`, which is deliberately non-runnable. No provider request may run until current official-source evidence reconciles the platform, booking URL, and metadata to one family.
- `Course.monitoringMode` is the durable per-course routing strategy. `AUTOMATIC` uses the full ordered ladder; `SERVER_ONLY` never queues a local reader; `BROWSER_ONLY` still preserves typed and official HTTP checks before its rendered-browser stage; `LOCAL_READER_ONLY` is reserved for an already proven reader-only strategy and may skip the earlier automatic paths explicitly; and `CONTACT_ONLY` is a terminal known limitation backed by current official evidence. Contact-only and explicitly local-reader-only courses avoid repeatedly rediscovering the same proven routing fact.
- Reader jobs declare a parser capability and minimum version. A reader reports its build and capabilities on every signed poll, and the backend leases only compatible jobs. Generic safe CPS, TenFore, and public Chronogolf routes use reusable parsers without course-specific extension releases. When a compatible reader comes online, a prior `READER_RELOAD_REQUIRED` incident is automatically returned to investigation for exact revalidation.
- A failure fingerprint is a hash of the normalized provider family, failure class, operation, and HTTP status bucket. It contains no course name, recipient, URL, token, or raw error text.

Customer-facing readiness is derived independently from internal engineering state. The five customer states are `CHECKING`, `MONITORED`, `RETRYING_AUTOMATICALLY`, `NEEDS_HUMAN_REVIEW`, and `FINAL_DIRECT_ACTION`. Only `MONITORED` is effective monitoring. `FINAL_DIRECT_ACTION` is reserved for authoritative current facts such as phone/walk-in booking, no online tee times, private/non-course identity, or a current action the golfer must take on the official site. Provider policy text alone is never a final monitoring disposition.

Send one setup report covering all five selected courses within 10 minutes, even while the later stages continue. At T+30, send one deduplicated consolidated update for courses that entered human review or reached a factual final. Customer copy must say “Manual review needed; your alert remains active” and offer the official site for current tee times. Do not expose adapter, probe, queue, Prisma, Codex, incident, playbook, or other engineering terminology.

`NEEDS_ADAPTER` and `FETCH_FAILED` mean `RETRYING_AUTOMATICALLY` while the bounded ladder is active; they are not proof that monitoring is impossible. `CHECK_PENDING` is permitted only while a current bounded reader job is active and must not survive that reader's five-minute window. Human-review alerts remain active and are rechecked every six hours. They also recheck immediately after changed provider evidence, a new compatible reader capability or build, a deployment, operator action, or another material official-source change.

A responder may close a course automatically without runnable monitoring for authoritative phone/contact/walk-in evidence or a verified invalid/private identity. Contact-only finalization requires an explicit `CONTACT_ONLY` strategy plus a same-origin HTTPS official source; an old manual flag or third-party URL is insufficient. Account-required and CAPTCHA/queue evidence may become a precise automatic technical final only after the complete current-cycle ledger, a terminal local-reader observation, and a matching independent observation prove the same limitation. Without that proof, the course enters human review and remains active. Source-unverified, contradictory, stale, reader-install, tooling, and official-link verification failures always remain human-review states. `AUTOMATION_PROHIBITED` and policy text are legacy evidence, never terminal monitoring dispositions. Restored runnable monitoring must supersede the newest failure with fresh exact-runtime workflow proof.

## Durable Monitoring Lifecycle

`CourseMonitoringStatus` is the one-row current state for each course. `CourseMonitoringEvent` is its append-only, redacted operator history. Search-scoped probes remain on `CourseProbe`; source evidence remains on `CourseAutomationDiscovery`.

- `HEALTHY`: the latest public signed-out read returned `MATCH_FOUND` or `NO_MATCH`.
- `DEGRADED_RETRYING`: the first failure is recorded without erasing the last working time. The search retries within two minutes.
- `AUTO_INVESTIGATING`: the current incident cycle is progressing through the ordered playbook. It cannot remain here past the 30-minute endpoint.
- `ENGINEERING_VERIFICATION_NEEDED`: the bounded playbook stalled or finished without proof of recovery or a safe factual/technical final. The customer sees manual-review wording, the alert remains active, and safe revalidation runs every six hours.
- `FINAL_MANUAL` and `FINAL_IDENTITY`: strong official manual-booking or identity evidence may close automatically.
- `FINAL_TECHNICAL`: two independent current observations, including a terminal local-reader observation, prove the same precise technical limitation after every applicable playbook stage is recorded. A legacy technical final without that current-cycle proof is requeued for revalidation.

If a required stage cannot run, the watchdog records an automation-stalled human-review reason at 30 minutes instead of leaving the course pending or inventing exhaustion. A successful read from any safe retry restores `HEALTHY` automatically. Material changes to the official link, provider family, access evidence, reader capability, deployment, operator action, or failure fingerprint reopen automated investigation immediately.

## Claim, Lease, And Repository Safety

Claiming requires all of the following:

- a clean `automation/course-support-*` task branch;
- checked-out `HEAD` exactly equal to current `origin/main`;
- the real Codex task id from `CODEX_THREAD_ID` or `--owner-thread`;
- fewer than two healthy active responder batches, with no active batch for the selected provider-family/failure-fingerprint group. The shared approved checkout still permits only one code-changing `IMPLEMENTING` owner at a time; the additional owner must remain classification/verification-only until that writer releases the checkout.

Claim returns a redacted `batchRef`, then `packet` exposes only bounded course ordinals and safe official roots. Every path must be recorded with `claim-path` before that file is edited. A path claim is rejected when another active batch already owns the same file or provider/parser scope, so concurrent responders cannot silently modify the same reusable implementation. The database lease token and row ids never leave the command implementation.

When a durably closed `RETRYABLE_FAILED` batch is due and coordination requires that exact retry, pass its private reference with `claim --retry-batch-ref`. The claim fails closed unless every prior entry is still `RETRY_SCHEDULED`, currently due, unowned, and unchanged in incident, course, cycle, provider family, and failure fingerprint, and no outside critical real-demand candidate is due. It never falls back to unrelated queue work, and the private reference must not be copied into reports or logs.

For a multi-course source batch whose entries have different retry times, coordination may select exactly one immutable source-entry ordinal with `claim --retry-batch-ref <private-ref> --retry-ordinal <NN> --max-courses 1`. Source-entry ordinals use the persisted batch-entry order (`createdAt`, then the private row id as a tie-breaker); they are not course-name order and must never be accompanied by a row id or course name in task output. Exact-entry mode still requires the whole source batch to be a durably closed retryable batch with unique, latest `RETRY_SCHEDULED` entries, then revalidates the selected entry's current cycle, provider provenance, due time, demand, ownership, and source-entry relation inside the ordinary serializable claim fence. Unselected siblings need not be due. Any invalid ordinal or mismatch aborts without falling back to the normal queue.

The responder uses the transaction-scoped Postgres advisory lease `tee-time-spot:course-support-writer` only for short inspect/claim/recovery state transitions. The hourly loop uses its own `tee-time-spot:hourly-improvement-writer` lease. Up to two durable responder batches and unfinished responder `AutomationRun` rows may own different provider groups during their longer classification/verification intervals, matching the global provider I/O ceiling and leaving Codex capacity for unrelated work. Because scheduled tasks share the one approved dispatch checkout, only one active batch may enter `IMPLEMENTING` or own planned code paths at a time; the other batch remains database/browser verification-only. A responder lease lasts 15 minutes and must be heartbeated while work continues. For an investigation expected to outlast one lease, start the bounded `heartbeat --watch` command in a separate process. It renews every four minutes by default, stops after 45 minutes by default, fails immediately if ownership is lost, and never changes the release fence.

An expired batch can be recovered only when branch, expected `HEAD`, owner-task provenance, committed paths, and dirty paths match the saved batch plan. A commit made before release heartbeat is recoverable only when the base is an ancestor and every committed path was already claimed. A different task cannot adopt dirty work. Unplanned paths, another responder writer, an active responder lease, or mismatched provenance require owner attention.

Recovery atomically transfers the batch and lease token to the recovering task. After `recover` reports success, continue that same batch directly through heartbeat, verification, and closeout; never claim a fresh batch. A later `inspect` supplies the current task identity and returns `resume_owned_work` only for that task's own healthy batch. Missing or mismatched task identity and another responder batch still fail closed as `deferred_busy`; hourly activity is outside the responder lane.

When an expired batch cannot be adopted because its checkout provenance moved, `recover` refreshes `origin/main` and may safely requeue the batch instead of blocking the lane indefinitely, but only when the checkout is clean, no changed candidate release was published or deployed, and every batch entry is still pending or stale. An unchanged runtime may persist the batch base SHA as its release SHA and deployment timestamp; those records prove baseline verification, not a published remediation. A recorded recheck dispatch is eligible only after every batch entry has been durably classified as stale evidence; pending or mixed dispatch evidence still fails closed. A persisted candidate SHA is not by itself a published release. The transition does not adopt, reset, publish, or delete the local branch. It atomically closes the abandoned batch as retryable, releases each incident, records a short future retry, and closes the unfinished automation run. Any dirty checkout, changed published or deployed release, pending dispatch activity, terminal evidence, human decision, or concurrent state change still fails closed for owner attention.

## Search Execution And Fresh Proof

Each search check uses a separate 15-minute row-token lease on `TeeSearch`. Network calls happen outside a database transaction. Every provider request, including official-site discovery follow-ups, claims the destination family's distributed slot; multi-request adapter steps run sequentially. Provider work is capped globally at two requests and at one request per provider family. Completion is a compare-and-set on search id, `scheduleVersion`, and lease token, so a stale Workflow cannot overwrite a newer edit, pause, resume, or explicit check.

The local reader may lease at most two isolated jobs globally. Active customer jobs outrank detached verification, and two jobs from the same provider family never run concurrently. Each job owns its own tab and lease, so one stalled page cannot block four unrelated courses. The backend reuses fresh successful or terminal results; it does not turn a completed challenge, page mismatch, or reader error back into pending work.

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

The one-minute deployed verification-recovery cron may run one standalone `CourseSupportVerificationRequest` for a claimed release; the broader search/watchdog recovery remains on its five-minute cadence. With active golfer demand, that responder-owned request may continue the ordered background playbook, persist learned provider metadata, and reach the adapter-retry and reader stages while the owner-bound local verification watch supplies rendered-browser and independent-confirmation stages. It cannot by itself prove restored customer monitoring: any active future course/search pair invalidates detached success proof so the normal golfer Workflow remains authoritative. When no active future pair exists, exact-release success within the request window may be consumed as reusable release proof. Each request is bounded by both the 35-minute engineering horizon and the current customer endpoint minus delivery margin; an existing request may only move earlier, never later. A later unrelated transient failure is recorded as a new monitoring event instead of reopening completed release verification, and a retry that cannot start before the deadline becomes stale rather than waiting indefinitely. This covers active responder progression, engineering-only synthetic provenance, and historical real-demand incidents after their golfer searches end; `engineeringOnly` remains unchanged so notification and provenance history stay accurate. This is not a synthetic customer search: the verification request stores no user, recipient, search, match, slot, booking URL, or delivery payload, and the detached path cannot create customer-scoped rows or send email. Provider discovery may still update reusable canonical course metadata and append source-backed discovery evidence, including an official booking URL. It uses the same shared provider dispatcher and provider-family lease with one player and a bounded course-local daylight window. The request rechecks exact release/runtime ownership, incident state, current active demand, and the provider snapshot before discovery, before adapter I/O, at completion, and again when proof is consumed.

Detached success is accepted only for an exact-release `MATCH_FOUND` or `NO_MATCH` with `providerExecution=true`, a safe provider response, an unchanged provider fingerprint, and evidence newer than deployment, dispatch, and the incident's newest failure. It proves reusable provider readiness only; it never means a golfer received an alert. Unsupported metadata, account/CAPTCHA/queue barriers, unsafe booking destinations, and provider failures remain honest non-success evidence.

The first post-deploy `verify` may create a detached request and report only aggregate `detachedVerification.pendingCount` plus `detachedVerification.rerunNeeded`. Scheduled owners use `verify --watch --closeout`: one owner-bound command renews the lease, persists every eligible browser stage, waits for the one-minute deployed request recovery, re-verifies, requires two consecutive clean browser-stage scans, and performs derived proof-gated closeout. The second clean scan catches a detached result that advances the ledger into independent confirmation after the prior pass's browser scan. The watch fails closed on timeout or ownership/release/stage change and never marks an unexhausted playbook human. Closeout also fails closed while the exact-release request is queued or checking, when a success has not yet been consumed, or when current retry/cooldown evidence has not been copied into the batch proof. This prevents an immediate closeout from cancelling the check or discarding a provider `Retry-After`.

If `origin/main` advances concurrently before the first responder release is fenced, rebase the clean responder commit onto that fetched main. After a release is fenced, integrate fetched `origin/main` while preserving the persisted release as an ancestor of the new HEAD. The fence trusts intervening commits already present on `origin/main`; the remaining responder delta from that exact remote SHA to the candidate must be nonempty and contain only claimed paths. Once the exact release is durably fenced, later verification does not reinterpret already-persisted paths merely because `origin/main` advanced to that release. If the same owned batch needs a follow-up release after an earlier deployment, the release fence may advance only during an explicit `VERIFYING` heartbeat. The checkout must be clean on the claimed branch, the persisted release must be an ancestor of the new HEAD, and the responder delta after any trusted concurrent main advance must contain only already planned paths. The transition preserves the prior deployment, recheck, and ordinal verification evidence in bounded `releaseHistory`, then atomically clears the current deployment/recheck fields and non-human machine proof. Verification cannot continue until the descendant SHA has its own deployment proof. Recovery may preserve a clean planned descendant only for the original owner task; it never advances the release by itself.

An older success, a local check, a Workflow id by itself, or a new probe from a different runtime cannot resolve the incident. A persisted factual classification uses the classification-only path and does not pretend an adapter ran. A technical classification also requires the current-cycle local-reader and independent-confirmation proof described above.

## Worker Health And Deadlines

- Only the 2-minute scheduled responder invocation with `inspect --scheduled-cycle` updates responder worker health. Manual commands must remain diagnostically read-only with respect to worker health.
- The responder's expected cadence is 2 minutes with a 3-minute grace period. At 5 minutes overdue, persist the durable overdue state and send one deduplicated operator notice when operator email is configured. A later healthy scheduled cycle clears the overdue state without sending a recovery email.
- When unresolved course investigations exist, `/operator` must elevate a missing, paused, or overdue responder above the monitoring queue. Do not require an operator to infer a stalled worker from an unchanged queue count.
- A compatible local reader is expected to heartbeat at least every two minutes and has three minutes of grace. Five minutes without a compatible heartbeat is an operator-visible reader outage with one deduplicated notice; a later healthy heartbeat clears that outage state silently.
- Every reader job has its own five-minute deadline. Expiry produces a terminal reader result and one privacy-safe operator notification for the deadline sweep; it does not block schedule recovery, detached verification recovery, monitoring watchdog work, or unrelated reader jobs.
- Long responder `verify` and `closeout` operations renew the owned batch lease while they run. Prisma deadlock and write-conflict failures receive bounded retries; they do not justify duplicate closeout or skipped proof.

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

The first retry for a new or materially changed course runs by T+2 minutes. The remaining applicable stages continue inside the 30-minute playbook window. A provider `Retry-After` for rate limiting is honored between 1 minute and 24 hours, but it cannot leave the customer in an indefinite pending state: the T+30 endpoint becomes human review when safe proof cannot complete. Human-review alerts persist `nextAttemptAt` for a six-hour safe recheck. The responder derives current real-demand count and earliest target date from live owner-scoped searches using each course's local calendar day instead of trusting a stale incident snapshot. New real demand promotes priority and triggers immediate revalidation when current proof is absent.

An engineering-only incident may continue safe revalidation after its first task closes, but it may remain `AUTO_INVESTIGATING` for at most 30 minutes. At that deadline it must have working monitoring, a factual final, a fully proof-backed technical final, or a recorded `ENGINEERING_VERIFICATION_NEEDED` state containing the completed attempts and exact next action.

Closeout independently derives per-course and batch outcomes from persisted evidence:

- `success`: every incident has fresh runnable proof.
- `classification_only`: every incident has a final durable non-runnable disposition.
- `partial`: at least one incident resolved or received a final disposition and another remains retryable.
- `retryable_failed`: all unresolved work has a persisted future retry.
- `needs_human`: a concrete unavoidable action remains after safe automated work.

Terminal closeout additionally requires immutable proof snapshots, an unchanged incident cycle/version, complete recheck dispatch, a healthy workflow (or a later golfer stop) for every affected search, and a fresh post-dispatch check. Source, reader tooling, and not-found restrictions require human review rather than automatic finality. Authentication and challenge restrictions may finalize automatically only with the complete eight-stage ledger, terminal reader observation, and matching independent current observation; otherwise they also require human review. Engineering-only incidents may enter human review, but they never send course-support email unless real customer demand is active.

Privacy, delivery, unsafe-provider, migration, deployment, production-verification, authentication, environment, Git, command, recovery, and repeated-SLA failures are never routine closeouts.

## Task Retention Policy

The responder never performs sidebar cleanup. A separate low-priority maintenance automation archives old completed responder tasks only after activity and durable-closeout guards pass. Cleanup failure affects sidebar hygiene only and must never extend a batch lease, block provider work, or change production state.

## Operator Commands

Run commands through the environment that owns the target database. Structured output is redacted and should still be treated as internal operational evidence.

```powershell
# Scheduled automation only: this invocation owns responder worker health.
npm run automation:course-support -- inspect --scheduled-cycle

# Manual inspection does not update scheduled worker health. No branch or
# provider research is needed for no_due_work.
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

The dry run is diagnosis only and never satisfies a playbook stage. For a
claimed batch, `automation:course-support -- verify` finds only the caller's
owned browser-ready ordinals and repeats the ordinary signed-out browser read
without `--dry-run` before it classifies evidence. That persisted read may
complete `RENDERED_BROWSER_DISCOVERY` or, after a terminal reader result,
`INDEPENDENT_CONFIRMATION`. Do not substitute a dry-run trace for either
transition. The claimed-batch browser run persists reusable course discovery
and ledger evidence only: it does not write a search-scoped `CourseProbe` or
apply a terminal monitoring/incident state. Guarded batch verification and
closeout own those decisions so a newer golfer Workflow result cannot be
overwritten.

Direct `automation:browser-probe` invocation is diagnostic-only and rejects
calls without `--dry-run`. Persisted browser progression must run through the
owned `automation:course-support -- verify` batch so discovery, course updates,
and ledger transitions share the exact lease, release, incident cycle, and
inside-transaction ownership fence.

# Gate a classification-only release on the expected pre-mutation result.
npm run automation:browser-probe -- --dry-run --trace-json --course-name "<exact course name>" --limit 1 --expect-disposition MANUAL_FINAL

# When investigation justifies no code change, verify the shared adapter on the
# exact production deployment of the clean claimed base SHA. This is permitted
# only before paths or a release have been recorded.
npm run automation:course-support -- heartbeat --batch-ref <batch-ref> --status VERIFYING --current-runtime
npm run deployment:wait -- --sha <claimed-base-sha>
npm run automation:course-support -- verify --batch-ref <batch-ref> --current-runtime --deployed-at <iso-timestamp> --watch --closeout

# Verify classification evidence, or first run deployment:wait and then verify fresh probes from the exact deployed SHA.
npm run automation:course-support -- verify --batch-ref <batch-ref> --watch --closeout
npm run deployment:wait -- --sha <git-sha>
npm run automation:course-support -- verify --batch-ref <batch-ref> --release-sha <git-sha> --deployed-at <iso-timestamp> --watch --closeout

# The owner-bound watch retains and renews the batch while detached verification
# advances, requires a clean confirmation pass, and closes out from derived proof.
# Active golfer demand does not cancel this responder-owned progression: the
# customer remains in manual review
# while the background request performs the learned-metadata adapter retry,
# queues the local reader only after browser completion, and later requests the
# independent browser confirmation. A fresh golfer Workflow result is still
# required before restored monitoring is reported.
npm run automation:course-support -- verify --batch-ref <batch-ref> --watch --closeout

# Record a concrete unavoidable external action only after the current-cycle
# safe playbook is durably exhausted.
npm run automation:course-support -- mark-needs-human --batch-ref <batch-ref> --ordinal 01 --evidence "<bounded evidence>" --next-action "<one exact action>"

# One-shot closeout remains available for bounded manual recovery outside the
# scheduled watch lane and still derives its result from persisted evidence.
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
npm run automation:course-monitoring -- backfill-playbook
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

The lifecycle schema change is additive: it adds the nullable versioned attempt ledger, monitoring state/events, incident public references, confirmation/deadline/reminder and decision metadata, reader-candidate classifications, the automation-stalled human-review reason, and internal monitoring-status delivery support. Apply it before application code. Validate migration and dry-run/apply backfill on an isolated Neon branch first, use the direct production Neon connection for `prisma migrate deploy`, inspect migration status, and never print the resolved URL.

Roll out in this order:

1. Validate focused tests, the full suite, lint, build, UI smoke, and `git diff --check`.
2. Apply the additive migration in production.
3. Push the verified commit to `origin/main`, wait for the exact Git-created Vercel deployment, and verify the queue consumer/configuration, production routes, schedules, and logs without running duplicate provider probes.
4. From that exact deployed runtime checkout, run `automation:course-monitoring -- backfill-playbook`, record aggregate counts, then repeat with `--apply --actor-id <non-email-actor>`, and finish with another dry run that reports zero candidates. The command starts a fresh incident cycle with an empty, unexhausted ledger, preserves authoritative manual and identity finals, requeues open/active incidents, and revalidates active-demand technical finals that lack current two-path proof without inferring completed legacy stages. Never requeue the backfill while the prior application runtime is still live.
5. In the automation control plane, verify the primary responder is the sole active 24/7 two-minute schedule, invokes the current preflight and production inspection before reading the full responder contract, uses the selected checkout returned by preflight, and runs scheduled `inspect --scheduled-cycle`. It may dispatch up to two overlapping task executions that each own exactly one batch. Shared-checkout coordination must still permit only one `IMPLEMENTING` owner at a time; the other task may inspect, claim, wait, or verify without adopting that implementation scope. Verify that empty cycles stop after inspection and that the duplicate overnight responder is paused. Do not infer configuration success from this document.
6. Run three responder cycles in inspect-only canary mode. Then enable claims at the default batch size of 5.
7. Create 5 to 10 genuinely new production test alerts across different ZIPs, providers, and access patterns, using five first-time courses where practical. Measure alert submission to the five-course setup report and to each course's truthful endpoint. Continue beyond 10 alerts when timing, reliability, or finality is inconsistent; fix, redeploy, and repeat until consecutive rounds satisfy the contract.
8. For each live canary, require all five setup statuses within 10 minutes, every unresolved course at monitored/factual-final/human-review by 30 minutes, the reader last, no `CHECK_PENDING` beyond five minutes, no persisted or computed responder-overdue state, a responder worker heartbeat no older than five minutes, and deduplicated status/recovery delivery. Remove the test alert afterward while preserving reusable course/provider evidence.

Rollback is application-first when the additive columns remain harmless to the previous runtime. Do not reverse or destructively rewrite responder history. Pause claims, preserve incidents/batches, and retain the per-search Workflow, queue fallback, and daily safety-recovery path that protect saved demand.

## Safety Boundaries

- Use only official, public, signed-out, read-only provider surfaces. Never enter checkout, account, verification-code, CAPTCHA, Turnstile, Cloudflare challenge, waiting-room, or queue-gated flows; never bypass a block or rate limit.
- Do not add FlareSolverr, stealth drivers, proxy rotation, CAPTCHA solvers, challenge-token replay, or a paid browser-bypass vendor. Ordinary JavaScript rendering and a bounded passive wait are allowed; persistent access controls remain evidence.
- Treat account-required, CAPTCHA/queue, private/non-course identity, phone/walk-in, and unsupported providers as honest outcomes, not engineering successes. Provider or course policy text alone is not a monitoring outcome.
- Do not send course-support email for engineering-only synthetic incidents. Synthetic demand never outranks critical real demand.
- Do not expose recipients, alias addresses, signed stop links, provider tokens, raw provider responses, database ids, Workflow ids, or responder lease tokens.
- A course-level failure must not suppress checks or alerts for the golfer's other ranked courses.
- The golfer still books on the official site. The responder never books, holds, reserves, pays, or impersonates a golfer.
