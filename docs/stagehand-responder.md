# Stagehand and Sol responder

The local supervisor keeps durable jobs and immutable first-pickup/deadline
timestamps in Postgres. Stagehand finds an official-linked public source;
existing deterministic readers learn and independently replay the method.
Only backend-owned verification can activate an immutable recipe. Subsequent
checks execute that recipe without model calls. Normal search workflows,
canonical matching, deduplication and the email outbox retain delivery ownership.

## Local worker modes

`COURSE_DISCOVERY_WORKER_MODE` is local operator configuration:

- `STAGEHAND_SOL` is the normal default. Source discovery uses the pinned
  Stagehand 4.3.0 SDK and GPT-6.1 Sol at medium reasoning through the current
  ChatGPT sign-in. No API-key or alternate-model fallback exists.
- `REUSE_ONLY` disables cold claims, model preparation and inference. Existing
  recipe executions retain their ordinary claim/result and cancellation checks.
  Use this mode for the restart/changed-parameter acceptance step.
- `NATIVE_SOL` explicitly selects the prior Sol worker for rollback. A failed
  Stagehand run never silently switches strategies or resets a clock.

Source discovery receives ordinary public identity and alert parameters only.
It cannot provide times, executable actions, identity proofs or recipe metadata.
A bounded source-only checkpoint can resume trusted inspection on the one
automatic retry, using the same job, request, source fingerprint and original
deadlines. The fixed inspection and independent backend challenges stay fresh.
Incomplete reads never become an empty availability result.

The Stagehand browser connects to a private, owned and guarded local browser
context. Its loopback endpoint stays inside the trusted host/driver boundary;
it is absent from model input, public evidence, logs and recipes. Provider reads
retain the existing public request policy and global/family coordination. The
installed Tee Time Spot Local Reader and the user's Chrome profile are not
modified. Authentication, interactive challenges and transaction flows remain
unresolved outcomes rather than reasons to weaken the reader's controls.

## Admission and rollout

`COURSE_DISCOVERY_ENABLED=true` is required. The absence of
`COURSE_DISCOVERY_ROLLOUT_MODE` retains the existing bounded pilot; `PILOT`
explicitly chooses that behavior. Pilot owner, three targets, cohort and normal
search-creation enrollment remain unchanged. No general admission is inferred
from missing or malformed pilot configuration.

`COURSE_DISCOVERY_ROLLOUT_MODE=GENERAL` explicitly enables normal real-demand
searches after acceptance. Synthetic/automation traffic stays excluded. Existing
adapters and supported installed-reader paths keep their established routes.
Legacy engineering ownership must be preserved; unresolved targets must not be
stranded between the two responders. Pilot receipts and evidence remain stored.

Disabling `COURSE_DISCOVERY_ENABLED` stops new admission and saved-recipe
selection without deleting customer demand, recipes or evidence. Keep the
managed worker's activation receipt bound to its actual clean deployed commit;
stop it before changing the runtime checkout. Reuse the existing managed task
and recovery supervisor rather than creating duplicate scheduled monitors.

## Acceptance receipt

Passing tests or deploying this code does not prove acceptance. Record the
random selection process and every exclusion; independently confirm public
inventory without supplying worker routes or configuration. Create three
ordinary alerts only after readiness, then permit no source hints, manual job
claims/retries, configuration changes or completion commands during cold
learning. Preserve first pickup, original deadline, attempts, activated hashes,
independent replay evidence, canonical times, normal outbox acceptance and
matching mailbox timestamps. Require all three to receive matching alerts
within 15 minutes of their original pickup, with a five-minute target.

Restart the worker in `REUSE_ONLY`, change ordinary alert parameters and verify
fresh matching evidence from the same saved methods, zero discovery/model calls
and no duplicate already-sent match IDs. Report exact application/SDK/CLI
versions, elapsed times, recorded token usage and unproved limitations. Expand
to GENERAL only after these checks and the cancellation/failure/duplicate
checks pass.
