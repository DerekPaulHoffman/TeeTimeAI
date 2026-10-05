# Ten-minute course dispatcher

The sole `tee-time-spot-course-support-responder` automation dispatches course work every ten minutes. It starts at most five new course chats per ten-minute tick and may fill up to fifteen active course slots across three active future alerts, with at most five selected courses per alert. The product's existing three-alert limit per account remains unchanged. A shared course needs one worker even when several alerts select it.

The dispatcher creates one local Codex chat for each admitted course. It does not claim a provider batch or split an existing owner's batch. Each child consumes one durable, child-bound assignment and owns one course's normal responder batch. Provider requests retain the existing global limit of two and limit of one per provider family. Planned code paths and `IMPLEMENTING` authority remain serialized; fifteen course chats do not authorize fifteen concurrent provider requests or code releases.

Active real demand takes priority. An explicitly opted-in `TEST` search with `syntheticMultiCycle=true` may use the same per-course dispatch capacity while its native synthetic lifetime is active. It remains synthetic, its incident remains engineering-only, and its emails remain no-send. Ended, paused, deleted, or expired alerts cannot obtain a new active-alert assignment. Historical background work remains governed by the legacy grouped-claim contract in `course-support-responder.md`.

## Parent launch

Start the existing stable preflight once:

```powershell
node C:\dev\TeeTimeAI-responder-self-healing\scripts\automation\course-support-preflight.mjs --run --scheduled-cycle --course-dispatch
```

It validates the approved clean checkout, current main, generated client and configured browser, records worker health, and runs one production-backed dispatch plan. Use its exact `selectedCheckout` for every subsequent parent command. Stop on a setup failure or nonzero exit. An empty plan completes the tick without creating a chat. Do not run a second inspection, an ordinary claim, a catch-up tick, or another responder automation.

For each returned `RESERVED` launch item, start its launch record before calling a native chat tool:

```powershell
npx vercel env run -e production -- npm run automation:course-dispatch -- start --assignment-ref <private-assignment-ref>
```

Then call the Codex app's `list_projects` and use the saved repository project's returned ID with `create_thread`, local environment. The human authorized these separate course chats. Include the complete assigned-worker instructions in that initial prompt. The child may bootstrap its own linked worktree and read its privacy-safe binding state, but must wait without provider research, claims, product edits or email until binding is complete. It may receive its opaque assignment reference and the selected checkout, but no recipient, provider token or raw incident/course identifier.

Bind only the real native `threadId` returned by `create_thread`:

```powershell
npx vercel env run -e production -- npm run automation:course-dispatch -- bind --assignment-ref <private-assignment-ref> --child-thread <native-thread-id>
```

The child reads its binding state and proceeds only when it is bound to its own native identity; no follow-up message is required. A pending `clientThreadId` is not a native thread ID and cannot be bound as one. An ambiguous native creation result keeps its `STARTING` slot occupied. Do not create a replacement chat. Reconcile the original tool result with supported native task tools and bind the original child if it is unambiguously identified; otherwise report required operator action. A parent must never infer a child relationship from a title or a claimed model name. Existing ambiguous reservations and expired owners must remain visible as attention conditions; an empty new-launch list does not establish healthy completion for them.

Cancel only when there is proof that no native worker was created:

```powershell
npx vercel env run -e production -- npm run automation:course-dispatch -- cancel --assignment-ref <private-assignment-ref> --confirmed-not-started
```

Reservations, binding, expiry, exact claim consumption and cancellation are stored in Postgres `AutomationRun` audit records under the existing course-support transition lease. The immutable target identifies one incident cycle and alert context. Replaying the same ten-minute tick cannot add start budget. Pending assignments plus owned batches count against the fifteen-slot ceiling. Keep private assignment and native task references out of aggregate status reports.

## Assigned child

The child must create or reuse its own managed linked worktree for this repository and create a named `automation/course-support-*` task branch from current `origin/main`. This is the explicit assigned-worker exception to the older shared-selected-checkout rule. Never clone a repository, switch or clean the user's dirty checkout, or adopt another worker's files. Registered linked worktrees retain the same repository identity and must use the selected Vercel project. Dependency/client/browser readiness must be established before claiming; do not alter another checkout's generated client or installed reader.

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

Research and verification may wait while another child owns implementation authority. Claim paths and obtain the existing exclusive implementation authority before editing. Rebase an isolated candidate onto current main when required, verify the exact resulting candidate and use the normal owned release proof. Existing batch recovery retains its own provenance and does not silently transfer work to a new child.

Complete with verified fresh monitoring, a current factual/technical disposition, or a precise durable retry/engineering handoff. Never report a provider failure or missing metadata as proof that availability can never be supplied. Do not send manual emails. Synthetic outbox dry-runs do not prove rendering, transport acceptance or inbox delivery.

## Verification and timing

Record selection, durable reservation, native launch/binding, exact claim, discovery, verification, independent successful search checks, matches and exact current owner payload coverage separately. A healthy continuation and two distinct fresh current-production checks are needed for reliable monitoring. Available matching slots, prepared payloads, rendering, transport acceptance and inbox delivery remain separate gates.

Worker health expects a ten-minute dispatcher tick plus the existing three-minute grace. Fifteen-minute search/batch leases and provider retry cooldowns remain independent controls and are unchanged by the dispatcher cadence.
