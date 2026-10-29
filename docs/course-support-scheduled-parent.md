# Scheduled course-support bridge

Use the existing sole ten-minute course-support automation. Start its scheduled
turn with exactly one shell command:

```powershell
& 'C:\Program Files\nodejs\node.exe' C:\dev\TeeTimeAI-responder-self-healing\scripts\automation\course-support-preflight.mjs --run --scheduled-cycle --course-dispatch
```

Stop on a nonzero exit from the preflight, setup failure, or unavailable
production evidence. Use
the actual returned `course_support_preflight_context` and exact
`selectedCheckout` throughout this tick. Do not inspect or plan a second time,
change environments, create another automation, impersonate an owner, approve
permission requests, or send email.

For each actual `RESERVED` launch item, create one managed linked worktree from
current `origin/main` with the supported worktree tool. Wait for its final
registered path. Create a unique `automation/course-support-*` branch there
before edits. Preserve existing checkouts. Bind `$preflightContext` to the actual
returned context object, `$launchItem` to that exact `RESERVED` item, and
`$workerCheckout` to the final registered worker path. Do not manufacture a
context, item, base, native identifier, or readiness result.

Use the existing ignored `.codex-artifacts` location in the actual selected
checkout. The assignment reference determines a distinct artifact directory.
Do not invent another private directory, require a fresh directory to exist
already, or add an ad hoc `git check-ignore` or runtime probe before launch.
The supported supervisor validates the actual inputs and creates its output
directory. Keep the real preflight, worktree, branch, file-write and supervisor
failures as stops; preserve partial artifacts and the reservation on failure.

Save the two actual objects with exclusive UTF-8 writes, then run one supervisor
command. This recipe needs no production environment or additional planning:

```powershell
$ErrorActionPreference = 'Stop'
$artifactDirectory = Join-Path $preflightContext.selectedCheckout ('.codex-artifacts\course-dispatch-' + $launchItem.assignmentRef)
$contextFile = Join-Path $artifactDirectory 'context.private.json'
$assignmentFile = Join-Path $artifactDirectory 'assignment.private.json'
$outputDirectory = Join-Path $artifactDirectory 'supervisor'
[System.IO.Directory]::CreateDirectory($artifactDirectory) | Out-Null
$utf8 = [System.Text.UTF8Encoding]::new($false)
foreach ($artifact in @(
  @{ path = $contextFile; value = $preflightContext },
  @{ path = $assignmentFile; value = $launchItem }
)) {
  $bytes = $utf8.GetBytes(($artifact.value | ConvertTo-Json -Depth 100))
  $stream = [System.IO.File]::Open($artifact.path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
$supervisorScript = Join-Path $preflightContext.selectedCheckout 'scripts\automation\course-support-worker-supervisor.mjs'
& 'C:\Program Files\nodejs\node.exe' $supervisorScript --detach --context-file $contextFile --assignment-file $assignmentFile --worker-checkout $workerCheckout --output-dir $outputDirectory
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
```

Never overwrite an existing context/item or replay a supervisor invocation.
If saving either file fails, stop before calling the supervisor. A previous
partial save is retained evidence, not permission to fill in or retry that launch.

The supervisor owns validation, start, native preparation, permission proof,
binding, complete mode-specific prompt generation, and execution. Do not repeat
those operations manually, write another launch helper, copy worker instructions
into the automation prompt, substitute another CLI, or retry an ambiguous launch.
An exclusive marker prevents replay. Its returned PID means only that the
supervisor process started; native binding, claimed ownership, completed work,
deployed support, and monitoring remain separate facts in their own receipts.

`STARTING` and unclaimed `BOUND` authority expire after fifteen minutes, or when
the base changes. A later normal planner releases those slots while retaining
the original audit and any child identity. Late binding and claiming
independently reject callers after the deadline. A stopped research-only
executor is reconciled from its expired database lease and settled request; no
native-chat revival or special collector-recovery message is needed. Never
manually free implementation or release ownership.

Observe the same private supervisor/launcher receipts and process handles when
useful; never restart healthy work because a wait returned. On an existing
`continuationItems` handoff, follow `course-support-worker-continuation.md` using
the original native worker. An expired owned simulator implementation or release
stage requires the actual STOPPED or COMPLETED receipt and corresponding latest
failed/interrupted or completed/error-null terminal-turn proof, plus one successful
production `continue` reservation before the deterministic same-thread runner.
That runner owns native `thread/resume`, `turn/start`, and `continued`
acknowledgement; do not send another follow-up message or replay the first-turn
launcher. Read legacy worker instructions
only when the original plan returns the explicit tagged
`legacyInspection.handoff`; an empty launch list is not such a handoff.

Report factual aggregate admission, occupancy, startup, recovery, and attention
counts. Never equate an empty plan, a process PID, completed native turn, passing
tests, or deployment with restored monitoring. Runtime success still requires
two distinct fresh deployed checks of the current source. Synthetic transport
stays suppressed. Keep private identifiers, provider/course details, URLs,
recipient data, and credentials out of aggregate reports. Routine completed
generated course chats may be archived after thirty minutes using the supported
archive action; preserve their transcripts and database state.

For generated workers, do not use `read_thread` as terminal proof: the installed
legacy history store does not support `thread/items/list`. After each successful
preflight and required health inspection, including no-action ticks, get a fresh
supported chat inventory. Save all `pinnedThreads[].id` plus this parent chat ID
as a JSON array in an exclusive ignored private file. Run the read-only helper:

```powershell
& 'C:\Program Files\nodejs\node.exe' <selected-checkout>\scripts\automation\course-support-chat-cleanup.mjs --selected-checkout <selected-checkout> --protected-thread-ids-file <absolute-private-json-file>
```

It inspects at most ten old original launcher receipts per invocation, uses
the database-only active inventory (so archived receipts cannot consume the
inspection budget), `thread/read` without turns and `thread/turns/list` with `itemsView=notLoaded`,
and returns only original completed/error-null terminal turns at least thirty
minutes old with no active descendants. Archive only its `eligible[].threadId`
through the supported archive action. Retain every pinned, active, failed,
interrupted, resumed, recent or unverifiable chat. The helper never resumes a
chat, starts a turn, changes an assignment, sends email or archives a log itself.
Do not repeat an unavailable item-history call. Archiving preserves transcripts
and database state and is not evidence of course or customer recovery.

Credential-free worker setup first requires a clean named worker branch at
current `origin/main`. During that one preparation, the helper pins the exact
validated HEAD and branch. Another worktree's fetch may advance the shared
`origin/main` reference while dependencies install; that alone is not a worker
change. Any worker HEAD, branch, binding, identity, privacy or runtime drift
still stops setup. This does not renew an assignment or bypass the durable
claim, expiry, source, implementation or release checks.

If the parent finishes while the supervisor is still asynchronous, report
"dispatched" or "bound as observed", not a healthy or successfully running
worker. Include the observation time for an ongoing state. A later failed
receipt supersedes that startup observation without another human wakeup.
