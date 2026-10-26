# Stagehand source discovery

This module finds an unverified public routing source. It never exports times, recipes, adapter metadata, identity proofs or backend mutations. The normal worker owns fresh fixed inspection, the two server-issued verification challenges and activation.

`sourceDiscover({ job, cwd, deadlineAt, signal, onMetrics, outputDirectory?, createGuardedBrowser })` accepts the assigned job's original fifteen-minute clock and ordinary identity/input. Only name, official URL, address and timezone enter the model identity. Private context, current method hints, checkpoints, lease tokens and backend credentials are excluded. Source work ends at the minimum of original pickup+240 seconds shared across both allowed attempts, the original deadline and the caller deadline. No retry or wait resets that clock. A valid result is a strict three-key unverified source proposal with recorded native routing provenance. Missing or changed source authority fails closed.

The caller-private guarded browser factory must return an owned isolated CDP context through the existing native public-read request queue and provider leases. The driver has no independent Chrome-launch fallback. It uses Stagehand4.3.0 `localBrowser.connect`, selects only the broker's exact target ID, attests all SDK page IDs before operations and after popups, and rejects default/unknown contexts. The broker endpoint is never a model input or report field. Its `prepareNavigation` and `beforeAction` hooks admit only observed public navigation under the native host's policy. The broker owns Chrome closure and request-lease drainage; Stagehand disconnect alone is not browser cleanup proof.

The model adapter uses gpt-6.1-sol/medium through the user's current ChatGPT/Codex sign-in. It dynamically resolves the existing worker's restricted model catalog, CLI and environment helpers from the same checkout. An owned temporary model home carries the existing sign-in only for that process; account/read must confirm ChatGPT before a turn. No API-key fallback or model tools are available. The model process must exit and its temporary credential must be removed, as well as the browser being closed, before source handoff. Raw prompts and image transcripts are not captured.

`prepareSourceDiscovery({ cwd })` first imports the same checkout's generated Prisma client exports, without constructing a client or connecting to a database. Missing or stub exports fail with `LOCAL_GENERATED_PRISMA_CLIENT_UNAVAILABLE` before a cold claim. It then checks the installed SDK/version, restricted catalog/CLI and local sign-in file readiness without opening a browser or starting a model turn. This is file-level readiness; the actual owned client separately checks account type. Preparation returns no credentials or catalog content.

With the managed worker stopped and its owned processes drained, run `npm ci`, then `npx prisma generate` in the maintained runtime checkout before readiness. Dependency installation alone can leave the generated client absent. Require a successful import-readiness result from that exact clean checkout before starting cold work; do not substitute another checkout's generated files or reset any job clock. Prisma generation and this import check do not prove database connectivity or explain an earlier worker failure.

No artifact directory is required. When explicitly supplied by the controller, the module saves only its bounded source report. There are no venue seals, historical cohorts, experiment ONCE files, fixed checkout paths or automatic CLI entrypoints.

Focused offline tests:

```sh
node --test scripts/automation/stagehand/*.test.mjs
```

Tests exercise native SDK-shaped extract/observe/act results, strict source-only output, same-job clock/privacy, exact observed ancestor/redirect and frame provenance, popup settlement, transaction guards, abort/cleanup, structured model messages, bounded JSON-RPC/large input echoes and temporary credential cleanup. Real SDK import/version resolution is checked without browser/model startup. Guarded host integration and owned local browser fixture evidence are separate from these offline tests; unseen production acceptance remains a separate gate.
