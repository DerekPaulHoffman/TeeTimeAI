# Assigned worker launch supervisor

The dispatcher still runs one preflight and one plan. Its tiny Codex automation bridge creates a distinct managed linked worktree from current `origin/main`, gives it a unique `automation/course-support-*` branch, and saves the exact preflight context object and one returned `RESERVED` launch item as private JSON files. The bridge invokes one supervisor process per reserved assignment. It may detach that process with a hidden window and private stdout/stderr files. The script does not create a managed worktree or schedule itself.

```powershell
& '<absolute-node>' <selected-checkout>\scripts\automation\course-support-worker-supervisor.mjs `
  --context-file <absolute-private-context-json> `
  --assignment-file <absolute-private-reserved-item-json> `
  --worker-checkout <absolute-managed-worker-checkout> `
  --output-dir <absolute-private-ignored-or-external-directory>
```

The invocation must inherit the real native parent `CODEX_THREAD_ID`. The input files and output directory belong to that assignment; never reuse an output directory for another invocation. The supervisor checks the selected approved checkout, pinned CLI, clean exact base, worker branch, project binding, and runtime before any dispatch command. It writes an exclusive start marker, then calls the existing production `start` command, prepares one native child through the existing launcher, binds only its proved thread ID, writes the complete mode-specific child instructions, and runs its one first turn. It does not inspect or plan again.

The private `supervisor.receipt.private.json`, `launcher.receipt.private.json`, stage logs and one-turn marker are distinct evidence. `ATTENTION` means preserve the original assignment and native chat state. In particular, a `PREPARE_REQUESTED`, `BIND_REQUESTED`, or `TURN_REQUESTED` failure may have caused a side effect; never re-invoke the supervisor or create a replacement chat. The dispatcher’s finite ownership deadline and supported native/batch reconciliation handle unresolved starts. Only a successful `COMPLETED` receipt with the launcher’s native identity proof establishes completion of the first turn; it does not prove customer delivery or monitoring health.
