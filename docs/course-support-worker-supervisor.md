# Assigned worker launch supervisor

The dispatcher still runs one preflight and one plan. Its tiny Codex automation bridge creates a distinct managed linked worktree from current `origin/main`, gives it a unique `automation/course-support-*` branch, and saves the exact preflight context object and one returned `RESERVED` launch item as private JSON files. Follow the exclusive UTF-8 artifact recipe in [course-support-scheduled-parent.md](course-support-scheduled-parent.md): use `<actual-selected-checkout>/.codex-artifacts/course-dispatch-<actual-assignment-ref>/` for inputs and its `supervisor/` child for output. This existing ignored location removes discretionary directory selection from the scheduled bridge. The bridge invokes one supervisor command per reserved assignment. The script does not create a managed worktree or schedule itself.

```powershell
& '<absolute-node>' <selected-checkout>\scripts\automation\course-support-worker-supervisor.mjs --detach `
  --context-file <absolute-private-context-json> `
  --assignment-file <absolute-private-reserved-item-json> `
  --worker-checkout <absolute-managed-worker-checkout> `
  --output-dir <absolute-assignment-artifact-directory>\supervisor
```

The invocation must inherit the real native parent `CODEX_THREAD_ID`. The input files and output directory belong to that assignment; never reuse an output directory for another invocation. The supervisor CLI creates a missing output directory before canonical validation; do not require it to exist beforehand or invent a separate ignore-path/setup gate. `--detach` validates the inputs and creates an exclusive dispatch marker before spawning the same supervisor command with private stdout/stderr, no shell, and a sanitized environment. Its `dispatched` result proves only that the operating system created a process. The foreground supervisor checks the same guards, writes a separate exclusive worker start marker, calls the existing production `start` command, prepares one native child through the existing launcher, binds only its proved thread ID, writes the complete mode-specific child instructions, and runs its one first turn. It does not inspect or plan again.

The private dispatch marker, `supervisor.receipt.private.json`, `launcher.receipt.private.json`, stage logs and one-turn marker are distinct evidence. `ATTENTION` means preserve the original assignment and native chat state. In particular, a `PREPARE_REQUESTED`, `BIND_REQUESTED`, or `TURN_REQUESTED` failure may have caused a side effect; never re-invoke the supervisor or create a replacement chat. The dispatcher’s finite ownership deadline and supported native/batch reconciliation handle unresolved starts. Only a successful `COMPLETED` receipt with the launcher’s native identity proof establishes completion of the first turn; it does not prove customer delivery or monitoring health.
