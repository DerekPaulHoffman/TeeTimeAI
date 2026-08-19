# Course-Support Process Learning Log

This file records generic process lessons only. It is not a provider-family note and scheduled responders must not read it during routine claimed work. Live incident and monitoring state remains in Postgres.

## 2026-08-18 - Stop Unchanged Repair Retries

### Observed Pattern

The investigation backlog could grow while responders remained active because a closed batch did not necessarily represent a repair. Some implementation-required failure classes could follow the same time-based retry path as transient provider outages, and an evidence-only verification of the unchanged runtime could close as another scheduled retry. That created activity without new provider support, new evidence, or a truthful endpoint.

### What Helped

- Durable incidents and provider-family/failure grouping prevented duplicate per-check incidents and exposed reusable provider leverage.
- The ordered attempt ledger preserved the current stage, result, runtime, and proof boundary.
- The monitoring strategy already distinguished transient provider failures from discovery and adapter-repair work.
- Exact-runtime verification correctly remained the only proof of restored monitoring.

### What Did Not Work

- Treating missing source, missing metadata, unsupported-family, parser, schema, or unknown failures as generic transient retries.
- Re-running an unchanged application runtime when the selected action required adapter or parser implementation.
- Letting a retry timestamp by itself make an otherwise identical approach novel.
- Keeping only coarse closeout counts without a reusable record of which engineering approach worked, failed, or became stale.
- Manually duplicating adapter capability lists in docs without checking them against the central registry.

### Process Decision

- True transient retry classes are limited to rate limit, provider 5xx, timeout, and network failures.
- Discovery and implementation-required work must advance to a different safe stage or reusable change, or reach the bounded human-review/final endpoint.
- A stable attempt signature must cover strategy, stage, normalized provider/failure state, runtime, material provider evidence, and reader capability. The same signature cannot consume another responder implementation cycle.
- Reopen only for a material change, a new exact release, a new compatible reader capability, changed current official evidence, or a matured persisted transient retry gate.
- Keep one privacy-safe Markdown note per provider family, updated only for reusable learning. Postgres remains authoritative and must enforce the novelty rule.
- Keep provider capability status sourced from the central registry and test documentation claims against it so notes do not become a second stale registry.

### Success Measures

- Zero repeated claims for an unchanged attempt signature.
- Zero unchanged-runtime verification cycles for adapter-repair actions.
- Zero incidents left in automatic investigation beyond the bounded endpoint.
- Every responder batch either advances a safe stage, changes reusable implementation/evidence, restores monitoring, records a factual final, or reaches a concrete human-review endpoint.
- Track created versus resolved incidents, exact-runtime restorations, classifications, repeated-signature suppressions, no-progress closeouts, courses restored per reusable release, and same-fingerprint reopen rates.

### Durable Guardrails Added During Review

- A claimed path or closeout label is not proof that technical work ran. Count an approach only from a deployed runtime change, exact current-runtime provider execution, a post-claim playbook event, or a durable terminal result.
- Track zero-work operational failures separately from the technical attempt budget. Allow only a bounded unchanged retry, then wait for a named environment, runtime, provider, or operator change.
- An implementation-required batch must include a committed runtime-bearing path. Documentation and tests may accompany the change but cannot satisfy implementation by themselves.
- Reserve the single implementation checkout as soon as the route requires code, before the first path is claimed, so verification work cannot steal it.
- Use one shared semantic provider projection for retry signatures and material-change detection. Configuration that affects execution may reopen work; refresh timestamps alone may not.
- A successful deployed reusable provider repair may wake eligible parked incidents for that same family. An unrelated deployment must not reopen them.
- Parked state, exact-runtime success, and factual final classifications use serialized compare-and-set transitions so a stale responder cannot overwrite newer truth.

## 2026-08-18 - Preserve Discovery Before Classifying It

### Observed Pattern

The official-site reader could observe a useful booking link and still leave the canonical course classified as source missing. Evidence was lost when a safe account landing was filtered with runnable-provider rules, when a one-sided leading-initial or page-extension difference prevented official-page scope, or when navigation links were truncated before booking links were prioritized. Repeating the same discovery then produced more attempts without improving the course record.

### What Helped

- Raw official anchors provided stronger source evidence than search snippets or extracted prose alone.
- Recognizing a provider from the official CTA before fetching its destination avoided treating crawler-specific denial as missing source.
- Keeping evidence-only account landings separate from runnable tee-sheet URLs preserved a truthful technical-access result without weakening provider safety.
- Rechecking an explicit bounded cohort exposed whether the producer fix generalized without waking the full parked inventory.

### What Did Not Work

- Using the runnable URL allowlist as the evidence-retention allowlist.
- Treating a physical-layout qualifier as harmless can collapse numbered sibling courses. A one-sided leading-initial prefix may be omitted only when the full remainder matches. A one-sided 9/18 qualifier is accepted only after a dry-run-first operator write verifies one exact physical layout from a corroborating official title/H1; unverified or multi-layout records remain strict.
- Comparing a page slug while retaining its file extension.
- Taking the first navigation anchors before ranking booking CTAs.
- Treating any title or provider alias containing `city` and `golf` as harmless organization branding. That let a sibling name such as Papago hide inside an organization-shaped label and bind its facility to Aguila.
- Fetching layout evidence against one course snapshot and then writing it without carrying that snapshot through the serialized write. A concurrent rename or layout update could make otherwise valid evidence stale before persistence.
- Showing a generic source-missing label when structured discovery had already identified a booking surface or access constraint.

### Process Decision

- Preserve safe official CTA evidence first, then separately decide whether it is runnable, account-gated, challenged, or still ambiguous.
- Scope provider identity from the official course page and CTA before interpreting a downstream fetch failure.
- Treat organization-shaped title segments and shared provider aliases as neutral only when their organization name is corroborated by the official page origin. Evaluate target-overlapping layout or sibling discriminators first; `Aguila 9 Golf Courses` remains course identity, while `City of Phoenix` on `phoenix.gov` is narrowly neutral.
- Reject future-dated layout evidence at both command and persistence boundaries. Carry the pre-fetch course name and `updatedAt` through the advisory-locked write and fail closed if either changed while the official source was being read.
- Keep production validation bounded to explicit ordinals, record sanitized normalized outcomes, and leave unresolved browser/adapter work with the owned responder instead of auto-retrying everything.
- Operator text must summarize the newest structured discovery reason so a developer sees what was actually found and what concrete step remains.
- When an official page qualifies an otherwise exact stored course name with 9 or 18, record the singleton physical layout through `automation:course-profile -- physical-layout` before retrying discovery. The command safety-checks redirects, never follows account routes, and rejects a source whose title/H1 contains a conflicting course identity.

## 2026-08-18 - Do Not Turn Parked Visibility Into Automatic Work

### Observed Pattern

Legacy automation-stalled incidents had durable, cycle-scoped endpoint proof but predated the explicit `parkedUntilMaterialChange` marker. Deadline reconciliation cleared their automatic schedules, then the human-review visibility step treated them as ordinary retryable rows and restored a six-hour attempt timestamp in the same watchdog pass. The responder could not claim those `NEEDS_HUMAN` rows, but the persisted timestamps made the operator surface look queued and were renewed indefinitely.

### What Helped

- The responder claim query already excluded `NEEDS_HUMAN`, preventing the misleading timestamps from consuming Codex worker slots.
- Existing endpoint events carried exact incident, cycle, escalation, and automation-stalled proof, so legacy rows could be upgraded without repeating provider discovery.
- Separate reminder timing allowed human-review visibility to continue without scheduling automatic remediation.

### What Did Not Work

- Clearing `nextAttemptAt` in deadline reconciliation without carrying the parked classification into the later visibility step.
- Treating a six-hour human-review timestamp as harmless when the operator UI could reasonably interpret it as queued AI work.
- Requiring only the new marker and leaving older, otherwise authoritative endpoint evidence on a perpetual compatibility retry.

### Process Decision

- A newly persisted automation-stalled endpoint is parked for the remainder of the same watchdog pass.
- Strong legacy endpoint proof is upgraded once with a distinct idempotent parking marker; incident and monitoring automatic schedules are cleared atomically.
- Repeated watchdog passes may advance `nextReminderAt` only. They must not queue searches, create responder work, increment the playbook cycle, or restore automatic attempt timestamps without a material provider, failure, reader, implementation, or operator change.
- Operator inventory keeps proof-backed, zero-demand stalled work in a separate **Waiting for new evidence** bucket. It must not inflate **Needs attention**, imply that automated work is active, or say an AI recheck is scheduled. Explicit account, CAPTCHA, reader, and active-demand decisions remain developer-action items.

## 2026-08-19 - Preserve Evidence While Superseding Current Truth

### Observed Pattern

Course-support improvements can correctly change the best current provider or booking classification while accidentally making an earlier source-backed fact disappear from the mutable course snapshot. An omitted metadata field can also be mistaken for an instruction to erase it, and replaying a stored discovery can make old evidence look newly observed. Shared facility pages add another risk: one page can truthfully describe different booking rules for sibling courses or layouts.

### What Helped

- Append-only discovery and monitoring-event records already separate historical observations from the one-row current course and monitoring projections.
- Course-snapshot compare-and-set writes prevent a stale investigation from silently winning over a concurrent correction.
- Exact course identity and official-source corroboration keep many facility-level statements from leaking onto a sibling course.
- Explicit evidence review dates let an old fact remain in history without remaining authoritative forever.

### What Did Not Work

- Treating an omitted URL, phone, or provider-metadata field as proof that the previously verified value is false.
- Re-inserting or applying stored evidence with a new timestamp and thereby extending its freshness without a new source read.
- Keeping every old value in the current snapshot forever. That can combine metadata from different providers, retain a dead booking destination or phone number, preserve an obsolete access barrier, or keep a manual disposition after public online booking becomes available.
- Treating a facility-wide page as one undifferentiated course fact when its named sections describe different courses, layouts, days, or reservation methods.

### Process Decision

- Never update or delete an accepted discovery or monitoring event. Append a correction or conflicting observation with its own source, scope, provenance, confidence, and original observation time.
- The mutable `Course` row is the best current projection, not the historical ledger. A new observation may supersede that projection only when it is fresh and at least as course-specific and authoritative as the fact it replaces.
- A failed fetch, missing link, absent optional field, or inconclusive discovery does not negate an earlier explicit fact. Clearing a projected value requires fresh contradictory or revocation evidence and an explicit clear operation.
- Replaying persisted evidence may reuse the original observation, but it must retain the original observation time and review deadline. Replay is not a new verification and must not renew freshness.
- Resolve current truth by course scope, source authority, observation time, and confidence. Equal-strength contradictions remain visible in history and move the current projection to review instead of being merged or guessed.
- On shared pages, bind a rule only to the exact named course or verified layout section. Facility-level facts may guide discovery but cannot silently override a more specific course fact.

### Success Measures

- Every accepted correction leaves the prior discovery queryable.
- Zero snapshot fields are cleared because an optional input was omitted.
- Zero replay-only operations extend `intelligenceVerifiedAt` or `intelligenceReviewAt`.
- Source-missing and transient failures never erase a previously verified booking route or direct-action fact.
- Provider changes never combine a booking URL from one family with execution metadata from another.
- Mixed facility evidence remains scoped to the correct course or is escalated as a visible conflict.
