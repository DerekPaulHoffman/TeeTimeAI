# Release and recovery guide

Tee Time Spot production is deployed from GitHub `main` through the Vercel Git
integration. Git, Vercel deployment metadata, Prisma migrations, and structured
`AutomationRun.audit` records are the durable release ledger. Do not append
per-run narratives to this file.

## Release

1. Start from current `origin/main` on a clean task branch.
2. Run focused tests, full tests, typecheck, lint, and the production build.
3. For additive schema changes, validate the exact migration on an isolated Neon
   branch. Apply the production migration before application code that depends on
   it.
4. Re-fetch `origin/main`, reconcile the task branch, and rerun affected checks.
5. Commit with a customer-readable title and push without force:

   ```powershell
   git push origin HEAD:main
   ```

6. Wait for the deployment created from the exact commit:

   ```powershell
   npm run deployment:wait -- --sha <commit-sha>
   ```

7. Verify the production alias, migration state, public routes, authenticated
   dashboard, active workflows, pending deliveries, and runtime logs.

Never run a separate CLI production deployment after the Git push. The Git
deployment is the release source of truth.

## Recovery

- Inspect customer schedule and delivery state with
  `npm run automation:inspect`.
- Use `npm run automation:poll` only for guarded manual recovery; it is not a
  scheduler.
- Inspect provider incidents with
  `npm run automation:course-support -- inspect` before any responder action.
- The five-minute recovery cron owns overdue search schedules, delivery retries,
  queued verification requests, and engineering-worker health checks. A failure
  in one recovery class must not suppress the others.
- Database worker state is authoritative for the course-support and product-
  improvement automation controls. A `PAUSED` worker must stop before claiming
  work.

## Verification evidence

Record release and automation evidence in the systems that own it:

- Git commit and branch history for code.
- Vercel deployment ID, commit SHA, status, and logs for runtime.
- Prisma migration history for schema.
- `AutomationRun.audit` for structured run results and runtime versions.
- `AutomationWorkerState` for current worker cadence, heartbeat, completion, and
  overdue/recovery notification state.

Database-backed Course Guide publication does not require a new application
deployment when the current production release already serves the profile
routes. Verify the published profile row, canonical route metadata and
structured data, sitemap membership, both production aliases, and current
runtime logs. Record the per-run sources, changed routes, and measurements in
`AutomationRun.audit` rather than appending a release narrative here.

Keep secrets, customer identifiers, raw recipient data, and copied error payloads
out of documentation and audit summaries.
