# Ten-minute course dispatcher

Simulator offerings share this dispatcher, its start budget, occupied slots and native binding fences. A `mode: "SIMULATOR"` assignment uses the offering-scoped commands and original child prompt in [simulator-support-responder.md](simulator-support-responder.md); it must never consume an outdoor `CourseSupportIncident`.

The sole `tee-time-spot-course-support-responder` automation dispatches course work every ten minutes. It starts at most five new course chats per ten-minute tick and may fill up to fifteen active course slots across three active future alerts, with at most five selected courses per alert. The product's existing three-alert limit per account remains unchanged. A shared course needs one worker even when several alerts select it.

The dispatcher creates one local Codex chat for each admitted course. It does not claim a provider batch or split an existing owner's batch. Each child consumes one durable, child-bound assignment and owns one course's normal responder batch. Provider requests retain the existing global limit of two and limit of one per provider family. Planned code paths and `IMPLEMENTING` authority remain serialized; fifteen course chats do not authorize fifteen concurrent provider requests or code releases.

Active real demand takes priority. An explicitly opted-in `TEST` search with `syntheticMultiCycle=true` may use the same per-course dispatch capacity while its native synthetic lifetime is active. It remains synthetic, its incident remains engineering-only, and its emails remain no-send. Ended, paused, deleted, or expired alerts cannot obtain a new active-alert assignment. Historical background work remains governed by the legacy grouped-claim contract in `course-support-responder.md`.

## Parent launch

Start the existing stable preflight once:

```powershell
node C:\dev\TeeTimeAI-responder-self-healing\scripts\automation\course-support-preflight.mjs --run --scheduled-cycle --course-dispatch
```

It validates the approved clean checkout, current main, generated client and configured browser, records worker health, and runs one production-backed dispatch plan. Use its exact `selectedCheckout` for every subsequent parent command. Stop on a setup failure or nonzero exit. Do not run a second inspection, a catch-up tick, or another responder automation.

When the writer lease is acquired and the plan has no launches, no live reservations or native-start/binding attention, and no eligible active-future course waiting for capacity, that same production CLI invocation runs the legacy inspection. Its tagged `value.legacyInspection.handoff` may authorize `RESUME` of the exact parent-owned batch, `RECOVER` of the exact expired legacy batch, or one `BACKGROUND` course through `CLAIM --max-courses 1` for historical/requestless work or a parked campaign. Use the returned batch reference for resume/recovery and the existing bounded grouped-batch recovery contract; do not split an old batch or transfer an assigned child's ownership. A grouped new active-alert claim, an expired assigned-worker batch, incomplete candidate-history evidence, or an unsettled native reservation never produces this fallback handoff. The claim/recovery transaction still rechecks current authority and can refuse stale admission. The tagged result also reports aggregate customer-recovery counts; pending cases remain visible even when there is no new course chat.

The parent reads and caches the full `course-support-assigned-worker.md` instructions once for native course-chat creation. Read `course-support-legacy-worker.md` only when the tagged legacy handoff is present; an empty plan alone does not authorize legacy work.

For each returned `RESERVED` launch item, start its launch record before creating a native chat:

```powershell
npx vercel env run -e production -- npm run automation:course-dispatch -- start --assignment-ref <private-assignment-ref>
```

Prepare a distinct managed linked worktree from current `origin/main` for that child, using the supported worktree tool. Create its unique `automation/course-support-*` branch there before any edits. Preserve every existing checkout. Use the bundled Codex executable from the current desktop installation; the launcher qualifies only the exact versions `codex-cli 0.160.0` and `codex-cli 0.160.1`. The current desktop installation uses `0.160.1`; do not use the older executable resolved by PATH. Desktop updates may change the executable's absolute installation path. Verify that current installed path and exact version before launch; an unqualified version must stop until its app-server protocol and permission acknowledgements are explicitly qualified.

The assigned-worker launcher uses the supported local app-server protocol to create an idle persistent native chat. It verifies that `:danger-full-access` is allowed, then requires the returned `approvalPolicy=never`, `dangerFullAccess` sandbox, exact profile and checkout before any model turn. Its actual native identity is persisted in an exclusive private receipt. Do not use `create_thread` for this lane: its current tool interface cannot select permissions before the first turn and caused the bootstrap approval prompts. Do not change global approval settings, accept pending approvals, or fall back to an approval-requesting profile.

Create an ignored private receipt directory and run the launcher outside the production environment wrapper:

```powershell
node <selected-checkout>\scripts\automation\course-support-worker-launcher.mjs prepare --codex <verified-bundled-codex-executable> --cwd <own-worker-checkout> --receipt <absolute-private-receipt-path> --title "Resolve assigned course"
```

It returns only after native creation and permission acknowledgement. Saved app project identifiers are not app-server project identifiers; do not substitute one into the RPC. The desktop recognizes these real native chats from their managed repository checkout. Omit model/thinking overrides and preserve the configured model. A creation error or unknown result retains its private receipt and `STARTING` slot; never retry creation automatically.

Bind only the real native `threadId` returned by the successful launcher preparation:

```powershell
npx vercel env run -e production -- npm run automation:course-dispatch -- bind --assignment-ref <private-assignment-ref> --child-thread <native-thread-id>
```

After successful binding, write the cached complete assigned-worker instructions to an ignored UTF-8 prompt file, substituting only the exact assignment reference and selected checkout. Start `run --receipt <same-receipt> --prompt-file <private-prompt-file> --node <absolute-node-executable>` with the same launcher. Use a hidden detached local process with private stdout/stderr files so each worker continues while the parent admits the other courses. Record its process handle; never restart it because a wait returned. The launcher proves that the prepared chat has no prior turn, re-applies the same permissions before its first turn, and checks the actual `CODEX_THREAD_ID` through its first read-only shell command. Private npm cache/prefix survive into each shell; Codex may prepend its own executable wrappers to PATH, so setup and production command helpers invoke absolute Node/npm paths. Production/provider/email credentials are excluded from startup; only later authorized production wrappers load the required environment.

The child independently reads its binding state and claims only its exact one-course assignment. No follow-up message is required. An unexpected approval request stops this owned worker without approving it; a preparation/startup failure must not trigger repeated user questions or automatic replacement chats. Observe the same private receipt and supported compact native `wait_threads` result. Full `read_thread` item hydration is currently unsupported for these app-server chats; that error is not permission to resume or duplicate a live process. The receipt, native compact result and durable batch evidence remain distinct facts.

Assigned-worker production commands use `course-support-worker-runtime.mjs production --selected-checkout <parent-selected-checkout> --script <allowed-script> -- <exact-arguments>` with absolute Node. The helper pins the verified Vercel package, invokes absolute Node/npm at both wrapper layers, retains the production environment boundary, and rechecks native identity, private runtime and the parent's repository/project binding. Only `automation:course-support`, `automation:course-dispatch`, `automation:simulator-support` and `deployment:wait` are permitted; their own authorization, action and release validators remain authoritative. Dirty or descendant work can be valid after claim, while the claim itself retains its exact current-source fence. No fallback to bare npm/npx is permitted in this child. After private setup, the child may copy the parent's existing ignored `.env.production.local` into its own ignored file for sensitive values Vercel cannot pull; never print or commit it, or load those values during npm setup.

A pending `clientThreadId`, inferred title or invented identity cannot be bound. Reconcile an ambiguous creation only against the original receipt and supported native task state. Existing ambiguous reservations and expired owners remain visible as attention conditions; an empty new-launch list does not establish healthy completion for them. The parent never resumes an existing chat through this launcher; its one-turn marker permits only the authorized initial task of the newly prepared child.

Cancel only when there is proof that no native worker was created:

```powershell
npx vercel env run -e production -- npm run automation:course-dispatch -- cancel --assignment-ref <private-assignment-ref> --confirmed-not-started
```

Reservations, binding, expiry, exact claim consumption and cancellation are stored in Postgres `AutomationRun` audit records under the existing course-support transition lease. The immutable target identifies one incident cycle and alert context. Replaying the same ten-minute tick cannot add start budget. Pending assignments plus owned batches count against the fifteen-slot ceiling. Keep private assignment and native task references out of aggregate status reports.

## Same-worker recovery

The human approved bounded continuation of the same existing simulator worker. The original preflight plan may return private `continuationItems` plus aggregate continuation counts; this is not authority to create another worker or run a second planning inspection. Follow `docs/course-support-worker-continuation.md` for fresh supported native completion, original private launch/profile proof, exact reviewed tooling readiness, durable `continue` reservation, one supported existing-chat message and `continued` acknowledgement. Use the complete simulator continuation prompt from the selected checkout. Never resume through the initial launcher, infer native liveness from RUNNING, repeat an ambiguous send, approve a permission request or reset a claim/request budget. At most one continuation per tick and two per original assignment/source are allowed. Missing or hard-failed evidence stays visible as attention.

## Assigned child

The child uses its own parent-prepared managed linked worktree and verifies its unique named `automation/course-support-*` task branch at current `origin/main`. This is the explicit assigned-worker exception to the older shared-selected-checkout rule. Never clone a repository, switch or clean the user's dirty checkout, or adopt another worker's files. Registered linked worktrees retain the same repository identity and must use the selected Vercel project. After the launcher's native identity check, run absolute Node with `course-support-worker-runtime.mjs --establish-binding --selected-checkout <parent-selected-checkout>` without production environment loaded. The helper compares only exact parsed projectId/orgId, preserves a matching existing file, and may exclusively create a missing binding in the child's own ignored private .vercel directory. Newline, formatting and projectName differences are not project mismatches; never compare file hashes. Invalid, different or shared-path bindings stop without overwriting either checkout. Require successful binding_ready before `course-support-worker-runtime.mjs --prepare --selected-checkout <parent-selected-checkout>`. Private setup invokes the installed npm CLI directly with private cache/prefix, generates its private client with inert database configuration, checks Chromium, and rechecks all ownership/readiness guards after each stage. Missing or changed readiness stops without asking for routine approvals; do not alter another checkout's generated client or installed reader.

Read this document, `AGENTS.md` and the per-course responder contract from the clean worker checkout. Require current native `CODEX_THREAD_ID`, clean named task branch and `HEAD == origin/main`. Read only the assignment bound to that native child:

```powershell
npx vercel env run -e production -- npm run automation:course-dispatch -- assignment --assignment-ref <private-assignment-ref>
```

An `awaiting_binding` response permits a bounded read-only wait, with no provider work or claim. Wait at most three minutes and space reads at least fifteen seconds apart; then leave a visible binding blocker. A `bound` response is required before continuing. A wrong native child or any nonzero command result is a concrete fence, not permission to retry or choose ordinary work.

Claim exactly that assignment, never ordinary queue work:

```powershell
npx vercel env run -e production -- npm run automation:course-support -- claim --max-courses 1 --dispatch-assignment <private-assignment-ref>
```

The claim atomically revalidates the alert, course, incident cycle, due time, source snapshot, capacity and bound native child, creates one child-owned batch, and consumes the assignment. A stale or invalid assignment must stop without falling back to a different course. Never claim a second course. Preserve the returned action plan, incident ownership, path claims, evidence, source, browser/reader, verification and release fences. Use the existing bounded per-course playbook; a new chat is not permission to restart an exhausted stage or bypass technical access controls.

Scheduling recovery and delivery retries may advance `scheduleVersion` without changing the golfer's request. A new assignment therefore records a private digest of the owner, recipients, ranked courses, requested date/window, player/layout choices, cadence and synthetic authority. Binding revalidation and the locked claim permit a nondecreasing schedule version only while that digest and `alertGeneration` remain unchanged. An owner/email change, alert edit, lifecycle or lifetime change, removed course, regressed schedule version, or stale incident/source/native ownership still invalidates the assignment. Legacy assignments without the digest retain their original exact-version fence. Raw recipient or request values never appear in the audit or aggregate report.

Research and verification may wait while another child owns implementation authority. Claim paths and obtain the existing exclusive implementation authority before editing. Rebase an isolated candidate onto current main when required, verify the exact resulting candidate and use the normal owned release proof. Existing batch recovery retains its own provenance and does not silently transfer work to a new child.

Complete with verified fresh monitoring, a current factual/technical disposition, or a precise durable retry/engineering handoff. Never report a provider failure or missing metadata as proof that availability can never be supplied. Do not send manual emails. Synthetic outbox dry-runs do not prove rendering, transport acceptance or inbox delivery.

## Verification and timing

Record selection, durable reservation, native launch/binding, exact claim, discovery, verification, independent successful search checks, matches and exact current owner payload coverage separately. A healthy continuation and two distinct fresh current-production checks are needed for reliable monitoring. Available matching slots, prepared payloads, rendering, transport acceptance and inbox delivery remain separate gates.

Worker health expects a ten-minute dispatcher tick plus the existing three-minute grace. Fifteen-minute search/batch leases and provider retry cooldowns remain independent controls and are unchanged by the dispatcher cadence.
