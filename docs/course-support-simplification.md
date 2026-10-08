# Make course support finish without a human restart

This is the implementation and evidence register for the October 2026 responder
repair. It distinguishes a working scheduler from working monitoring. A launch,
successful command, completed research attempt, green test suite, or Ready
deployment does not establish that a golfer's selected course can be monitored.

## Decision checklist

- Keep the existing per-search Workflow, Postgres incidents, provider adapters,
  source fingerprints, email outbox, and the sole course-support automation.
- Make startup and execution recovery ordinary coded operations. A native chat
  is an executor, not the permanent owner of a customer's unresolved problem.
- Expire unclaimed launch authority after a finite deadline. Preserve the old
  assignment and native identity; reject late binding and claiming. An orphan
  chat is a cleanup concern, not permanent capacity ownership.
- Recover claimed work only through a fenced lease and durable checkpoint.
  Never reset request history, overwrite a newer source, adopt unrelated dirty
  work, or treat lease expiry as permission to publish an unknown release.
- Separate provider backoff, positive technical-access restrictions, ownership
  loss, and local tooling failure. Each has a different next action.
- Keep signed-out public reads, SSRF/DNS protections, request coordination,
  account/challenge/checkout stops, and exact deployed-runtime verification.
- Keep synthetic delivery suppressed. Do not send operator or customer email
  from this repair, change the three real alerts, or extend the fixed benchmark.
- Remove procedure and exceptions only after a simpler replacement proves the
  same safety property. No new service, database, or duplicate automation.

## Evidence and corrective decisions

| Component or earlier decision | What the evidence establishes | What it does not establish | Corrective decision |
| --- | --- | --- | --- |
| Permanent `STARTING` reservations | Three old launches retained physical slots after their synthetic source searches ended. The planner expires `RESERVED`, but not `STARTING`; only the original parent can cancel it. | The three slots do not explain every research failure or exhaust the fifteen-slot capacity. A missing binding does not prove a chat never existed. | Replace permanent startup authority with a finite deadline enforced by planning, binding, and claiming. Retain the audit and any actual child identity. |
| Bound chat without a claim | Stale source/base changes can revoke `BOUND`; elapsed startup time alone cannot. | Binding is not a claim, provider observation, implementation, or monitoring success. | Add a finite claim deadline. A late child must fail even before another planner tick runs. |
| Same-chat continuation | Recovery carries native-completion checks, compatibility observers, readiness proofs, continuation reservations, and historical collector exceptions. | Native metadata alone does not prove a worker is stopped, and an expired lease does not authorize unreviewed release adoption. | Move routine lifecycle operations into a deterministic supervisor; retain publication provenance and fencing. |
| Six-read research interface | Unfamiliar providers require deployed helper changes to expose newly useful routes. Raw scripts and responses are unavailable to the worker. | More requests alone will not make an inaccessible provider readable. | Carry useful sanitized failure and contract diagnostics into ordinary worker packets. The current six-read and traffic limits remain; a broader investigation interface has not been implemented or accepted. |
| Collector error stops the worker | A secondary resource/body-budget failure became `HARD_FAILED`; recovery later required a new release plus a narrowly matched exception. | A collector exception is not evidence that the course requires an account or has no online rentals. | Classify local tooling separately; preserve the read attempt, stop uncertain provider I/O, and allow local repair/tests or automatic fenced retry. |
| Derived booking-entry page | A new same-origin entry point let the next ordinary worker try a previously unreachable route. | The entry point itself is not rental or calendar proof. | Keep useful route discovery as a clue; remove venue-specific recovery procedure where a general rule can replace it. |
| Skip previously failed routes | Current-source request history can avoid repeating hard failures and HTTP 401/403/404. | HTTP 500 is not a permanent refusal. History does not prove all useful routes were exhausted. | Preserve request history across retries and distinguish transient backoff from exhausted investigation. |
| Provider HTTP failures | One ordinary attempt observed HTTP 403 and HTTP 500. Later research recorded an incomplete HTTP 200 page. | The external cause of these responses is unconfirmed; HTTP 200 does not prove a calendar rendered. | Preserve actual observations and test the reader/tooling boundary. Do not fabricate availability or blame a model, user agent, or provider without proof. |
| Earlier passing tests and deployments | They prove the tested invariants and exact published code. | They did not prove unfamiliar-provider completion without human nudges. | Add crash, late-write, duplicate-executor, tooling-failure, and complete unattended outcome tests. |

## Implemented correction register

| Change | Deleted or replaced behavior | Evidence and limits |
| --- | --- | --- |
| Deterministic normal-launch supervisor | The scheduled parent no longer assembles start/prepare/bind/prompt/run commands, private launch helpers or detached process plumbing. | Sixteen focused tests cover actual CLI envelopes, current base, native parent identity, duplicate markers, refused/ambiguous stages and sanitized detached startup. Native scheduled execution is still a separate acceptance gate. |
| Fifteen-minute startup/claim authority | Permanent unclaimed slots and original-parent cancellation as the only way to release capacity. | Unit and actual Postgres checks reject late binds/claims and preserve old audit/child identity. This does not assert the old chat never existed. |
| Research-only hard failure closes in its settlement transaction | Leaving a failed research execution owned until a custom same-chat continuation is approved. | The spent request, HTTP0 and failure remain; old reads/path/recheck/recover calls reject before I/O. Source or database settlement failure does not qualify. |
| Normal planner reconciles an expired research executor | Native-completion observers and special collector exceptions as a prerequisite to recover research capacity. | Actual Postgres checks simulate an interrupted reserved read, preserve its spent attempt, schedule retry, and fence the old owner. Still-bounded reads and implementation/release work are retained. |
| Source-scoped denied-route checkpoint | Forgetting the oldest failed route after four completed retries. | An actual Postgres sequence imports six old routes, carries them through six new executions, and rejects the old route before I/O. The checkpoint uses existing audit JSON, with no migration or extra service. |
| Carry sanitized failure diagnostics into replacement packets | Keeping only HTTP0/URL/mode, so a replacement could not distinguish browser startup, network, or document parsing failures. | The same bounded safe failure schema strips arbitrary exception data. Withdrawn demand preserves spent routes when the unchanged source later becomes eligible. Postgres and parser tests exercise both cases. |
| Incomplete HTTP200 history retains its collector version and diagnostics | Repeating an unchanged incomplete rendered page because HTTP200 looked successful to the route-history filter. | Relevant collector-version changes can reconsider incomplete pages; unrelated Git releases do not reset the checkpoint. Historical missing version/diagnostic fields remain unknown. |
| Configuration diagnostic identifies a fixed field/type | Ambiguous `RANGES / CONFIG_SHAPE` with no distinction between missing `ranges`, missing `items`, null, an array, or an invalid row. | Six shape controls preserve strict parsing and return no arbitrary names or values. This is diagnostic evidence, never availability. |
| Preserve validated main-document facts after stylesheet rejection | Erasing safe inert configuration because an unrelated stylesheet URL was rejected. | Rejected URLs remain blocked; incomplete rendering and main-document provenance remain explicit. No rendered DOM, response contracts, login or challenge state is promoted. |
| Correct the supervisor's draft response parser before publication | A draft test stub used a flat result instead of the real `{ acquired, value }` CLI contract. | Review caught this before live use. Refused, malformed, missing and stale-base envelopes now stop before native preparation. Passing stubs alone would have missed the defect. |

The exact latest native attempt before these changes completed its reads and
recorded retry; it did not implement monitoring. Two separate attempts repeated
an incomplete HTTP200 entry page. The latest independent signed-out browser
diagnostic rendered a provider error page on both booking routes. That supports
honest current backoff, but neither establishes a permanent technical restriction
nor proves that our earlier collector failures caused the provider's error.

Implementation/release provenance recovery remains deliberately separate from
research-only recovery. A temporary native chat can be replaced after its
research authority is revoked; an unknown dirty or partly published release must
not be adopted merely because its timer elapsed.

## Outcome checks

| Scenario | Required result |
| --- | --- |
| Parent dies before binding | A normal later tick expires launch authority and can admit new work. Old binding/claim attempts fail; the old audit remains. |
| Child never claims | Capacity is released after the claim deadline; late claims fail against database time. |
| Worker stops during research | The same job resumes from its durable checkpoint through a new valid lease. Previously spent reads remain spent. |
| Two executors overlap | At most one can persist evidence, claim paths, register a release, or close out. |
| Tooling fails | Record a system failure and repair/retry automatically; do not invent a provider restriction or require a custom human recovery message. |
| Provider is temporarily unavailable | Record honest bounded backoff and retry at the persisted time. |
| Provider positively requires an account/challenge | Persist that observed disposition and give the golfer the official site. No bypass. |
| Unfamiliar public simulator | Ordinary scheduled admission, investigation, reusable support, exact release proof, then two distinct normal deployed checks. Synthetic transport stays suppressed. |

Each implementation increment must record its exact local checks and remaining
unproved outcome here or in the associated verification receipt. Do not mark the
overall repair accepted while only startup, retry, or deployment has been proved.
