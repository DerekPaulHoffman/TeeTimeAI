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
| A native turn ended during implementation or verification | Research-only cleanup excludes registered paths and releases, while retained recovery accepted only a completed native execution. A failed or interrupted execution could retain ownership indefinitely. A completed native turn can also leave an unresolved database job open. | No current live retained implementation crash was identified. An ended chat or expired lease alone does not prove that the original checkout is safe to resume. | Recover the original worker through positive terminal-turn, process, inventory, source, path and release evidence, followed by a database reservation and atomic native continuation. |
| Repair after the first registered release | Progress can instruct `REPAIR`, but release registration rejects a different SHA and path/configuration operations are sealed. The same worker cannot publish the instructed correction. | This is a source-backed contradiction, not proof that every earlier simulator failure reached this stage. | Permit fenced original-owner repair, preserve earlier release history, invalidate old verification, and require fresh production checks. |
| Repeating a retained continuation | The original launcher receipt names its first turn. A later continuation produces a different latest terminal turn, so another recovery cannot match the original receipt alone. | An absent latest turn or an unavailable inventory is not terminal proof. | Record each accepted continuation's actual native turn and private receipt; validate that current lineage on the next recovery. |
| Preparing an already owned candidate | First-turn runtime setup requires HEAD at `origin/main`, while an owned repair or checkpoint correctly remains ahead of main. Repeating first-turn preparation rejects that candidate. | Reusing a stale or missing private binding is not safe. | Verify and reuse the existing private runtime for retained work. Keep first-turn setup out of the continuation instructions. |
| Incomplete pages excluded indefinitely | The ordinary 06:50 worker launched and closed with six reads remaining but zero allowed routes. Two incomplete public HTTP200 observations from 05:44 stayed excluded after an hour because the route checkpoint kept no timestamps and only a collector-version change could reconsider them. | Startup and durable retry did not mean a fresh site check occurred. The two pages do not prove current availability or a permanent technical restriction. | Retain original source, time and observed access evidence; permit bounded main-page revalidation after cooldown. Keep explicit access failures and unsafe resource targets excluded. |
| Finishing while a command was running | The 11:30 worker passed binding and runtime setup, started its assignment command, then finalized twenty seconds later without polling its recorded running handle. Seven completed commands hid an eighth unfinished command in the first observer summary. | No terminal assignment result or CLI failure was recorded. Native completion does not prove the command failed or the assignment was never attempted. | Require first-turn and continuation workers to wait on the same command handle through terminal exit. Do not restart or duplicate an uncertain mutation. Record started and unmatched commands in verification evidence. |
| Simulator engineering work after alert expiry | The fixed TEST ended normally, leaving an open due simulator incident. Selection drops incidents without active alerts, and simulator incidents are excluded from the documented legacy fallback. Every owned operation also requires active demand. | The active-alert expiry guard is correct. Reopening the TEST or changing only the selector would not create valid engineering authority. | Introduce separate incident authority from a positively consumed synthetic assignment, preserve the expired alert, and verify reusable monitoring with independent no-send deployed observations. This increment requires complete ownership and verification tests before publication. |
| Status failure and recovery emails | Saved status reports and durable probes show real MATCH_FOUND to FETCH_FAILED to MATCH_FOUND transitions. Each message has its correct deterministic identity and was accepted once. | A brief failure does not prove a permanent provider outage; accepted messages do not prove inbox delivery. | Preserve the current state-change policy during this responder repair. Document its noisy transient behavior separately; do not label it transport duplication or trigger manual sends. |
| Earlier passing tests and deployments | They prove the tested invariants and exact published code. | They did not prove unfamiliar-provider completion without human nudges. | Add crash, late-write, duplicate-executor, tooling-failure, and complete unattended outcome tests. |
| Expired incident deadline controls a newly owned engineering check | The original 18:10 Pequot worker had a live lease and pending first typed-adapter stage, but its October 5 escalation deadline stopped the watch before any pass or provider request. | The historical service deadline remains useful audit evidence. A newer heartbeat does not authorize extending an already created verification request. | Capture one fixed live-lease endpoint for an already overdue engineering-only incident without current customer demand. Recheck ownership, source and demand when scheduling; preserve existing requests and the original deadline. |
| Adapter implementation precedes public-page discovery | The original 18:40 Southington packet required code changes while its rendered discovery stage still lacked a current actionable booking contract. The worker inspected the missing contract and ended without durable closeout. | That absence is neither a provider access restriction nor evidence that a clean original checkout can be adopted. The recorded public identity was unknown, not false. | Let the existing owned rendered verifier collect the missing public-page evidence before requiring an adapter. Preserve explicit private/invalid and observed technical-access classifications. |
| Proposed cleanup does not fit the old packet | Review found that a new expired-diagnostic helper required HEAD at the original base, while normal recovery now uses a newer release. Its tests also assumed confirmed public identity instead of the recorded unknown value. The current durable join proves existing recovery already released that job for an automatic retry. | A passing invented fixture would not establish provider support. Freed capacity alone could not have proved the durable retry. | Remove the unnecessary helper and its recovery plumbing. Correct the routing at its existing decision point and test the recorded identity shape. |
| The same prerequisite is missed one stage later | The initial correction covered rendered discovery. Source reproduction showed the next browser-adapter retry still required implementation for the same schema failure without a current actionable contract. The scheduled 19:50 Tunxis worker then durably reached that pending next stage. | A completed discovery attempt is not necessarily a usable request/response contract. A failed stage with no retry budget must not receive extra attempts. | Use the same existing safe-source prerequisite check for both owned browser stages. Preserve positive-contract implementation and existing detached retry limits; add a regression that fails on the old next-stage route. |

## Implemented correction register

| Change | Deleted or replaced behavior | Evidence and limits |
| --- | --- | --- |
| Deterministic normal-launch supervisor | The scheduled parent no longer assembles start/prepare/bind/prompt/run commands, private launch helpers or detached process plumbing. | Sixteen focused tests cover actual CLI envelopes, current base, native parent identity, duplicate markers, refused/ambiguous stages and sanitized detached startup. Native scheduled execution is still a separate acceptance gate. |
| Fifteen-minute startup/claim authority | Permanent unclaimed slots and original-parent cancellation as the only way to release capacity. | Unit and actual Postgres checks reject late binds/claims and preserve old audit/child identity. This does not assert the old chat never existed. |
| Research-only hard failure closes in its settlement transaction | Leaving a failed research execution owned until a custom same-chat continuation is approved. | The spent request, HTTP0 and failure remain; old reads/path/recheck/recover calls reject before I/O. Source or database settlement failure does not qualify. |
| Normal planner reconciles an expired research executor | Native-completion observers and special collector exceptions as a prerequisite to recover research capacity. | Actual Postgres checks simulate an interrupted reserved read, preserve its spent attempt, schedule retry, and fence the old owner. Still-bounded reads and implementation/release work are retained. |
| Source-scoped denied-route checkpoint | Forgetting the oldest failed route after four completed retries. | An actual Postgres sequence imports six old routes, carries them through six new executions, and rejects the old route before I/O. The checkpoint uses existing audit JSON, with no migration or extra service. |
| Carry sanitized failure diagnostics into replacement packets | Keeping only HTTP0/URL/mode, so a replacement could not distinguish browser startup, network, or document parsing failures. | The same bounded safe failure schema strips arbitrary exception data. Withdrawn demand preserves spent routes when the unchanged source later becomes eligible. Postgres and parser tests exercise both cases. |
| Preserve each observation's original source during adoption | Rewriting the state fingerprint while preserving history could attribute an old configuration's failure to the corrected configuration. | Individual observations retain their source; the read budget is unchanged. Replacement history imports only matching observations. Legacy mixed-source observations without provenance remain unknown. Returning to the original source retains its original failure. |
| Incomplete HTTP200 history retains its collector version and diagnostics | Repeating an unchanged incomplete rendered page because HTTP200 looked successful to the route-history filter. | Relevant collector-version changes can reconsider incomplete pages; unrelated Git releases do not reset the checkpoint. Historical missing version/diagnostic fields remain unknown. |
| Configuration diagnostic identifies a fixed field/type | Ambiguous `RANGES / CONFIG_SHAPE` with no distinction between missing `ranges`, missing `items`, null, an array, or an invalid row. | Six shape controls preserve strict parsing and return no arbitrary names or values. This is diagnostic evidence, never availability. |
| Preserve validated main-document facts after stylesheet rejection | Erasing safe inert configuration because an unrelated stylesheet URL was rejected. | The initial correction preserved validated main HTML when navigation could not complete. Rejected URLs remain blocked, with explicit incomplete rendering and source provenance. The resource-local correction below can also retain later observed DOM as incomplete discovery evidence. |
| Correct the supervisor's draft response parser before publication | A draft test stub used a flat result instead of the real `{ acquired, value }` CLI contract. | Review caught this before live use. Refused, malformed, missing and stale-base envelopes now stop before native preparation. Passing stubs alone would have missed the defect. |
| Correct retained-continuation test fixtures after full CI | Older unit mocks omitted the new research reaper and still represented expired research as retained continuation work. | Full CI caught four failures. These compatibility fixtures now represent implementation work with a claimed path, which retains provenance; the mock exposes the new boundary. Fifty-three focused continuation/dispatch checks pass. Actual research reaping remains covered by Postgres, not the mock. |
| Stop conflating launcher receipt failures with malformed native messages | The first normal supervised launch verified native identity but stopped before claiming while reading local instructions. One catch covered JSON parsing, event logging and receipt callback writes, so the original local cause was lost. | Separate safe failure codes now identify each boundary. Receipts persist only actual lifecycle/identity changes; transient Windows rename contention gets a finite retry. Fifty-two launcher/supervisor checks pass. Original filesystem contention remains a hypothesis; live acceptance of this correction is pending. |
| Correct Windows receipt tests on Linux CI | Two new tests assumed the test host was Windows, so Linux correctly refused the Windows-only retry. | Tests now inject the simulated platform and include a non-Windows single-attempt control. Runtime still defaults to its actual OS. Fifty-three focused launcher/supervisor tests, lint and TypeScript pass; exact-head complete CI remains a release gate. |
| Share the bounded receipt writer and preserve primary failures | The supervisor had a second, single-attempt atomic writer; failed cleanup or terminal diagnostic writes could replace the error that stopped startup. | The supervisor now uses the launcher's bounded writer. Cleanup and failure-report errors retain only safe secondary codes and cannot replace the primary error. Fifty-nine focused tests, lint and TypeScript pass. No failure authorizes replay or continued work. |
| Report asynchronous startup as an observation | The first scheduled parent's final reply said the bound worker was running, although the native failure receipt preceded that final reply. | The bridge now requires "dispatched" or "bound as observed" with an observation time while execution remains asynchronous. The durable terminal receipt determines later health; a startup snapshot cannot establish ongoing execution. |
| Give workers the public setup facts used by existing readers | Acuity and GolfBook monitoring need anonymous rental, tenant, template, duration and resource identifiers. The owned research packet stripped the inert source objects and form fields where those facts appear, so the worker lacked information available during direct investigation. | Bounded projections reuse the readers' existing identity and rental checks, persist only typed public selectors, and appear in the fresh owned guide. They clear on unsuccessful responses or observed access controls. No raw scripts, form state, contact details, session data, availability or extra requests are returned. 268 focused tests, 51 isolated Postgres checks, lint and TypeScript pass. |
| Match saved public configuration to its actual source context | Review found the draft persisted schema checked the provider family but could accept a different Acuity owner key or GolfBook sheet date. | The shared matcher now checks the exact observed owner/date as well as provider host/path. Foreign-context fixtures reject both cases. Projection facts remain discovery evidence; they cannot complete monitoring verification. |
| Version only the known-reader projection routes | A global research-version change could reopen unchanged incomplete Back9 pages; no change would hide the new known-reader projection behind older incomplete-page memory. | Exact recognized Acuity/GolfBook source contexts get the new version. Unrelated routes keep their version and denied history; explicit hard failures and access denials remain blocked. Focused tests cover both relevant reconsideration and unrelated retention. |
| Remove stale duplicate simulator instructions | The secondary simulator guide still described four-run forgetting, erased safe initial-document facts and original-chat-only research recovery after those behaviors changed. | Replace its procedural history with a short reference to the current assigned-worker contract and current lifecycle. Documentation is not runtime proof. |
| Resume a positively ended original implementation worker | Retaining registered work indefinitely after a failed, interrupted, or completed native turn leaves its database job open. | The planner returns the exact original checkpoint and token/revision. Fresh inventory/native/process/runtime proof reserves one continuation; a deterministic runner resumes the same thread and acknowledges its actual accepted turn. Ninety focused checks and 56 isolated Postgres checks pass. No live retained implementation crash was found for this acceptance run. |
| Preserve repeated continuation lineage | Comparing every later recovery to the immutable first native turn. | The durable SENT ledger records the actual accepted turn and private receipt. The next recovery validates that latest terminal turn and both original and prior process pairs. Missing native lineage, an ambiguous send, changed source, unknown paths or exhausted limits remains explicit attention. |
| Allow original-owner release and metadata repair | Immutable first release and sealed configuration/path operations contradicted the ordinary REPAIR instruction. | New code requires clean owned commits, trusted upstream and previous release ancestry, and registered changed paths. Prior proof is archived; active proof resets. Metadata repair retains the reader SHA but requires reviewed adoption and fresh checks. Same-SHA registration stays idempotent; dirty or different-HEAD completion rejects. |
| Give a replacement release its own normal verification requests | Reusing the first release's remediation dispatch key could suppress a replacement release's immediate check. | Dispatch identity includes the current release and source. A corrected release or adopted source must obtain two fresh normal checks; old successful checks cannot complete it. Actual local Postgres tests cover replacement and metadata repair. |
| Revalidate incomplete main pages after an hour | Treating unchanged URL/collector version as proof that a provider page could never recover. | Original time, request and observed access facts are retained and enriched only from matching owned source history. Due incomplete public main pages can consume a new bounded read; a fresh incomplete read renews cooldown. Hard/HTTP/access denials and unknown evidence remain fenced. Forty-one policy tests and 59 isolated Postgres tests pass. Live scheduled revalidation remains the separate acceptance gate. |
| Wait for a running command's terminal result | Treating a yielded assignment command as a missing result and finishing its native turn. | First-turn outdoor/simulator and simulator continuation instructions require polling the same supported handle. This corrects the confirmed 11:30 decision, but instructions alone do not prove every future native execution will comply. Unclaimed expiry remains the deterministic fallback. |
| Separate engineering incident authority from alert scheduling | An expired opted-in simulator TEST silently disappeared from the queue, and its supposed legacy fallback excluded simulators. | Positive prior consumed synthetic ownership supplies the original incident, offering and source lineage. Current active-alert checks remain unchanged. Engineering work follows active demand within existing start/physical caps, does not occupy an expired alert cohort, and returns no ended searches to recheck. Unknown or changed provenance remains fenced. |
| Verify reusable monitoring without a customer alert | Requiring active customer search probes for an engineering incident after its alert ended. | A private deployed command reserves and settles two distinct public availability reads under the original source/token/revision and current Git runtime. It persists bounded counts, clocks and classifications in the existing audit, creates no customer search/match/outbox rows, and never sends email. Actual local Postgres tests use the real ownership/writer layer and mocked provider responses; live provider acceptance remains separate. |
| Settle an interrupted verification and yield to customer demand | An expired pending request could leave WAIT_FOR_CHECK forever; new real demand could also block settlement while preventing retry. | Expiry preserves the spent attempt and rejects late proof. Customer demand prevents new engineering provider I/O; only the original pending reservation may settle or expire without updating health, then the clean owner can yield. Unfinished edits, active reads and unknown publication cannot be released. |
| Test the real transition envelope | The draft verification helper and its mock both treated the writer result as a raw value instead of `{ acquired, value }`. | Independent review caught this before publication. Every transition unwraps the actual envelope; busy acquisition performs no I/O or revision change. The two-read Postgres test exercises the real transition, so the raw stub cannot substitute for integration evidence. |
| Preserve repaired and failed verification evidence | An old source/release pair could be reused after repair, or failed evidence overwritten by another attempt. | Current identity starts a fresh bounded pair only after valid source/release repair; previous proof remains in bounded history. A copied clock, incomplete response, unobserved source, late response or booking-not-open result cannot qualify. |
| Keep honest retry for a clean published candidate | A draft guard excluded real-alert owners solely because they lacked engineering authority, even after their registered release was live. | Both authority kinds may release only clean exact published work with fresh Ready proof. IMPLEMENTING, unregistered/undeployed work, pending repair and active requests remain owned. Postgres coverage separately proves accepted published retry and retained unfinished work. |
| Continue safe page reads after a known leaf-resource failure | Two collector-owned outcomes globally stopped queued independently admitted scripts and public data: a rejected stylesheet URL, or an oversized secondary script/stylesheet. Natural Back9 booking-root reads reported the body cap; its FAQ reported a separate stylesheet rejection. | Abort only that leaf. Unsafe destinations are never requested and oversized bodies are never served. Existing 1.5MB response, 6MB aggregate, 32-request, 20-second deadline, public URL/DNS/redirect and hostname-lease guards remain. Successful navigation may return bounded observed DOM and sanitized public response contracts with an explicit warning and `renderComplete=false`; request-budget exhaustion and expected navigation timeout/abort keep main-HTTP-only fallback. Unknown, lease, aggregate, access and unsuccessful-main cases remain fenced. |
| Exercise genuinely admitted queued resources | The older stylesheet test used `/queued-*.js`, which the independent queue URL guard already blocked. That fixture did not prove what happened to permitted queued scripts. The first new Postgres fixture also used a resource label that correctly failed the existing public-bay identity check. | New public asset URLs and GET/XHR fixtures prove actual continued requests and unchanged lease serialization. Valid provider identity fixtures retain only strict typed rental configuration; an incomplete render cannot provide a complete public checkpoint. Both relevant collector versions change so prior incomplete tooling observations can be reconsidered without erasing hard, HTTP or observed-access denials. Guards were not weakened to repair the fixtures. |
| Identify the capped secondary leaf without exposing it | Natural Back9 16:00 and 17:10 reads on `e1a57021f63b9dc13b6491c565aa088c27da56c8` returned incomplete HTTP200 rendering with a body-limit warning, but the warning alone could not identify whether a script or stylesheet hit the transport or collector cap. | Owned cap errors now carry only closed resource kind, cap phase, observed size band and bounded count into the incomplete read and source-scoped prior history. The original 18:20 run on `d3e8047` persisted `SECONDARY_SCRIPT / TRANSPORT_HEADERS / OVER_2X_UP_TO_4X / count1`. Integrated ownership tests ran against isolated Postgres. This identifies a declared-size band, not the asset contents, completed calendar rendering or monitoring. Limits, retry eligibility and collector version remain unchanged. |
| Preserve bounded legacy bridge evaluation after history fills | The complete 17:35 aggregate history contained 26 events: one outdoor incident had 21 and was correctly fenced; five independently retained due incidents had one each. The bridge rejected the whole result because one incident exceeded its bound. | Permit `COMPLETE` or `PER_INCIDENT_BOUND_EXCEEDED` only after per-incident pruning, retaining aggregate truncation, `NOT_EVALUATED`, new-active and grouped fences plus atomic claim revalidation. Thirty focused checks passed. The original 18:00 run on `d3e8047` claimed one retained course, persisted browser discovery and scheduled the next stage; the overflowing incident remained unchanged. This proves unattended progress, not restored monitoring. |
| Use the authentic legacy public receipt | The original 18:20 worker correctly followed its guide, but repeated the entry page and FAQ. The actual older bays receipt was included and parsed; its durable warning/version were absent. The new recovery tests supplied a warning, so passing tests missed the real record shape. | Accept only an actual typed partial receipt with observed empty controls, original UUID/time, exact current source/URL/mode, all original prior tooling failures and cooldown. Missing optional diagnostics remain unknown. Remove only positively recovered exact keys from active denials; preserve raw history and all protected/nonrecovered routes. A pure replay of both actual inputs changes recovery from zero to one while preserving plain403. This correction still requires exact-head publication and a new ordinary scheduled page read. |
| Use a fixed current engineering verification window | Ending a newly owned verification watch before its first pass because the incident's historical escalation clock had expired. | Eligibility is frozen at packet capture; live ownership, source and demand are checked again before new requests. Existing requests keep their original immutable deadline across heartbeat. Customer, mixed-demand, future and null incident deadlines retain existing behavior. Focused watch tests and actual isolated Postgres checks pass; scheduled deployed execution is a separate gate. |
| Discover a booking contract before requiring provider code | Assigning adapter implementation while either owned browser-discovery or adapter-retry stage had no actionable contract. | The existing safe-source and monitoring policy permit read-only discovery for unknown public identity; explicit private identity and technical-access classifications retain their gates. The change does not set public identity, create availability or add recovery authority. Routing regressions cover the actual unknown-identity shape, safe/unsafe sources, access gates, implementation with a current contract, and the existing pending/failed-stage retry budgets. |
| Locate a public rental-configuration failure | The naturally recovered 19:30 bays read still returned RENTALS/CONFIG_ARRAY without a field. Nested restrictions, required-perks arrays and zero surviving rental options shared that message, while the redacted shape omitted the rental rows. The worker could not safely infer the missing configuration and made no reader change. | Fixed nested-field diagnostics and a separate no-eligible-rentals result preserve the same rejection. At most eight actual first-filter rejections include closed admin state and, only for explicitly non-admin rows, validated public numeric identifiers and short machine tokens. No names, raw payloads, missing defaults, version changes, extra requests or availability permission. The old observation remains unknown; the next owned read must supply these facts. |
| Repair a source-proven diagnostic gap before repeating research retry | The original 20:40 Back9 worker received the new guidance and observed three non-admin simulator options rejected by category. It explicitly noticed that no category token was retained, inspected source and passed 241 existing tests, but claimed no paths and made no repair before another sixty-minute retry. Local source shows the absent token combines missing, null, non-string and filtered-string values. The worker had conditional diagnostic-repair authority; missing calendar configuration did not prohibit it. | The assigned-worker contract now requires a bounded closed diagnostic repair when owned evidence and local source prove a useful omitted distinction can be retained safely. It uses existing path claims, focused tests, exact release/deployment proof and honest published retry. It does not guess category values, alter rental eligibility, add schema or flags, increase budgets, change collector versions, advance retry, or claim monitoring. The actual 20:40 result remains retry-only; future original scheduled implementation is the acceptance gate. |
| Keep local development feedback separate from operational failure | A later source audit found that the assigned outdoor/simulator and simulator-continuation templates included local verification in stop-on-any-nonzero rules. This contradicted the new failing-regression requirement and could terminate a normal repair with unfinished edits. The earlier phase-authority review missed this process boundary. It was not the cause of the observed 20:40 retry, whose twenty commands all exited zero. | Completed credential-free local test/lint/typecheck reports of assertion or code diagnostics now permit a concrete owned correction and focused rerun. The final candidate must still pass relevant local checks and trusted required CI before production publication. Unfinished-command restart, mutation duplication, crash, setup, identity, production, source, ownership, lease, access, timeout and permission failures retain their stops. No failed production operation becomes replayable. |

Recovery evidence correction: historical non-access tooling failures had priority
over a later actual owned partial HTTP200 read of the same source and route.
Back9's recorded bays read reached rental validation, while subsequent workers
were directed to a less useful entry page. The new rule uses only that actual
later receipt after sixty minutes and resolves every copied failure against
original history. It preserves all historical rows, distinct plain/rendered
routes and every explicit HTTP/access denial, including a challenge on HTTP503.
It does not establish calendar support or revive a failed executor. Integrated
local validation passes 243 collector/policy/recovery checks, 30 legacy bridge
and history checks, and all 75 ownership tests against the real isolated
Postgres database with provider and email transport mocked. Exact-head CI,
publication and an ordinary scheduled recovered-page read remain release and
live acceptance gates.

The original 18:20 run completed all 22 commands, two owned reads and durable
retry without a manual wake or unfinished command. It did not offer the saved
bays page, change product code or establish monitoring. A bounded read-only
trace reconstructed all 19 pre-claim records (20 after closeout; below 64), with
no parse error or protected rendered denial. The real bays partial was rejected
solely because its old durable record lacked the newly required warning. A
separate native response cannot fill that missing field. The compatibility
correction adds the actual missing-field shape to unit and Postgres fixtures;
34 focused tests and all 76 actual isolated ownership tests pass. Its pure
recorded-input replay preserves every input field, unknown reader version and
the separate plain HTTP403 route. The next persisted retry is 19:27 UTC; do not
advance it or reopen the completed test alert to manufacture live acceptance.

The later outdoor failures are separate from Back9's page-reader recovery.
Pequot's watch performed zero verification passes because an old incident
deadline was reused for new engineering work. Its correction freezes eligible
batch members and the live lease at packet capture; a deadline that expires only
after capture does not become eligible later. New customer demand prevents a
new engineering request. An isolated Postgres regression covers immutable
request replay after heartbeat, newly arrived customer demand, and a deadline
that was still future at capture. This is local request-authority evidence;
ordinary scheduled verification remains a separate live acceptance gate.

Southington's completed native turn left an implementation packet without code,
verification or closeout. The strict read-only join at 19:31 UTC proves existing
recovery subsequently closed that owner at 19:00:05, persisted RETRY_SCHEDULED,
and left the open incident due for rendered discovery with no active batch.
Its source fingerprint and six-event playbook were preserved. This is durable
automatic recovery, not provider support. The routing correction collects
missing evidence under the existing
owned rendered stage for a safe source whose public identity is not explicitly
false; it does not set public identity or authorize customer availability from
an incomplete page. Existing release, checkout, request-history and incident
recovery fences remain unchanged. No expired job is reset or reopened by this
change. Live acceptance must identify the actual new scheduled stage and its
result, rather than infer provider support from released capacity.

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

The retained implementation/release correction above is a separate increment.
It does not create a replacement chat or grant permission to
adopt another worker's edits. Original-owner release repair must preserve the
previous registered commit as an ancestor, register every new owned path, and
retain earlier deployment and recheck evidence in history. A replacement release
or reviewed metadata repair clears active verification; the responder must prove
the current source and release again before completion.
The existing two continuations per assignment/source and eight ledger entries
remain bounded. An unproved old app-send turn or exhausted recovery budget is
attention, not evidence of a healthy or automatically recovered course.

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

Live October 8 acceptance: the first ordinary supervised launch stopped before
claiming. The next ordinary ten-minute tick expired its unclaimed authority,
launched a replacement, and that worker completed two owned public source reads
and a durable retry/closeout without a human restart. Historical assignments and
request history remained preserved. This establishes unattended research recovery
on the initial repair release. The launcher and known-reader followup is live at
`216b6503e7b18ebd88226e62aa806704c30b5045`, with complete required CI, 28 public UI
checks, and all three real simulator controls observed on that runtime. The
original-worker terminal-stage increment has local proof and remains subject to
exact-head CI and publication. None of these facts establishes the unfamiliar
provider's calendar availability. Its next attempt remains owned by the ordinary
schedule; the fixed synthetic benchmark and its suppressed transport are intact.

The natural 06:50 run on `ba2c2ad74823764aff682b0f316bbe93e5c48034` completed
startup, claim and durable retry with zero new source reads. Its guide had six
reads remaining and zero suggestions: five plain HTTP403 routes, two rendered
hard failures, and two incomplete rendered HTTP200 routes were retained. This
proved another investigation stall, not fresh research. The incomplete-page
cooldown correction is a separate increment requiring local, exact-head CI and
natural scheduled revalidation proof; hard failures and observed access controls
must not be silently reclassified or forgotten.
The earlier decision was wrong to equate an unchanged URL and collector version
with unchanged future page contents. Its tests encoded that assumption and did
not simulate a provider recovering after cooldown. The new controls must prove
time-based revalidation of a previously incomplete public page without clearing
spent attempts, forgetting structural failures, or borrowing access evidence
from another observation.
Read-only correlation across 13 completed runs and 35 observations found no
recorded earlier same-URL/mode hard, HTTP or positive access denial for either of
the two current incomplete routes. No source attribution was unknown in that
correlation. This supports their bounded cooldown revalidation; it does not prove
current provider health, complete access, or calendar availability. Their next
attempt remains at the persisted 07:54 UTC retry, with ordinary admission expected
at 08:00 UTC (04:00 Eastern). The fixed benchmark is not advanced or extended.

The original21:50 October8 worker received the complete corrected self-repair
and local-test-feedback instructions, but its first production assignment read
exited1 before ownership. The worker correctly stopped without claim, provider
read, edits or release. Root's separate read of the already saved npm debug log
found package acquisition with16 ECONNRESET and1 ETIMEDOUT; no explicit terminal
causal stack was retained. These are tooling/network facts, not a provider
restriction or proof that the independently failed RO observer shared a cause.
The wrapper ran cold private-cache npm exec for Vercel before the assignment
script, and suppressed its own computed command_failed receipt. Earlier setup
verified Node/npm/client/browser but omitted the tool needed for production.

The correction puts the existing pinned Vercel62.2.0 in locked development
dependencies, verifies private package/entry/version during credential-free
setup, and directly invokes its prepared CLI for production commands. It
removes package acquisition from those protected calls and emits a closed
nonzero wrapper receipt without claiming absence of durable side effects.
The parent supervisor and continuation acknowledgement use the exact selected
checkout's prepared CLI. Existing reservation expiry, claims, production stops,
provider access rules, retry budgets and customer searches stay unchanged.
Independent review caught an initial fixture mistake: the real package declares
dist/vc.js, not dist/index.js. A real installed-package metadata test now covers
that boundary, plus private directory/file guards and post-smoke version drift.
Local89 focused checks, lint, TypeScript and actual schedulerNode22 CLI version
passed without production credentials or network. Exact-head CI/publication
and original scheduled autonomous repair remain required; no package readiness
or healthy ordinary customer check substitutes for Back9 monitoring proof.
An older original candidate also needs its own new private dependencies after
merging reviewed main. The continuation template now requires a verified clean
registered-work checkpoint and current-main ancestry, then credential-free
locked local refresh/version/generation before original inspection/recovery.
The first-turn --prepare origin/main guard stays strict. Parent selected
readiness alone is not evidence of original-child readiness; the earlier
template incorrectly said it was. No local refresh renews a lease or changes
source, spent attempts or publication history.
