# Learn once, run reliably: controlled pilot

This change adds a disabled-by-default discovery path. It is implementation and
test infrastructure, not evidence that three previously unseen venues have
passed the delivery target. The acceptance clock starts at the database's
immutable `CourseDiscoveryJob.firstPickedUpAt`; it ends only when the owner
confirms receipt of the matching alert. Provider acceptance of an email is a
separate timestamp.

## Runtime

1. A normal search check keeps established adapters and supported Local
   Reader sources. For an enrolled, unconfigured target it creates or joins one
   durable discovery job.
2. `npm run automation:learn-courses` polls the private API every 15 seconds.
   It runs at most three jobs, while the existing two global / one per-provider
   request leases still control provider traffic. Warm recipe checks have
   priority over new investigations.
3. The fixed local controller starts the pinned Codex CLI with only browser,
   checkpoint and recipe-proposal tools. The model cannot run a shell, write
   files, access database credentials, send email, or supply executable code.
   The trusted helper has the device credential needed for the private API.
4. A candidate is a versioned, hashed data-only `HTTP_JSON`, `BROWSER_DOM` or
   `EXISTING_ADAPTER`
   recipe. The controller runs two server-issued challenges in fresh runtimes
   with the model disabled. Outdoor verification changes player count;
   simulator verification changes date and preserves player context.
5. A corrected booking link requires evidence captured by the fixed browser
   controller, independently of the model's proposal. Activation rechecks source
   identity, fingerprint, demand and job lease in one transaction. The corrected
   link, active recipe pointer and successful job are committed together. A later
   source change invalidates the old recipe.
6. Subsequent checks queue a `LocalReaderJob` with purpose `RECIPE_CHECK`. The
   local supervisor executes its saved recipe without Codex. Fresh, complete
   results feed the existing match deduplication and email outbox. A failed
   recipe is withdrawn and produces a deduplicated repair job. An unavailable
   local browser is reported separately and retains the proven recipe for
   execution after the browser recovers.

The 90-second discovery lease is heartbeated every 15 seconds. A crash may
consume the one remaining attempt, but never resets the first-pickup time or
the 15-minute deadline. Discovery work stops at twelve minutes to reserve time
for execution and delivery. Exhausted attempts remain terminal for the same source
and alert generation. The first warm execution carries the original clock and
is capped by its deadline; subsequent checks have a three-minute budget. Results
expire after 90 seconds. Useful late checks are retained and reported as late,
not suppressed to make the timing look successful. These budgets do not prove the delivery SLO; the pilot
must measure discovery, replay, scheduling and delivery together.

Incomplete extraction, challenge pages and unavailable browser capabilities
remain explicit failures. They cannot create a `NO_MATCH` result. Cancellation,
edits, source changes and stale schedule versions are checked again before
canonical match writes. Simulator availability represents one full resource
rental; saved player count is not a bay-capacity filter. `24:00` means the next
venue-local midnight.

## Prepare without sending email

- Apply additive migrations to an isolated database first, then validate the
  candidate application. Production migration and deployment use the normal
  release approval path.
- Preserve the installed extension at
  `C:\dev\TeeTimeAI\tools\local-chrome-reader`. This implementation does not
  replace its files, identity, permissions, settings or providers.
- Install dependencies in the task checkout and make Playwright Chromium
  available. The supervisor requires the pinned `@openai/codex` installation,
  a signed-in local Codex account, and its existing model catalog.
- Set `COURSE_DISCOVERY_API_ORIGIN` in the supervisor environment to the exact
  application origin. Configure a separate server-side
  `COURSE_DISCOVERY_DEVICE_TOKEN` and supply that same value to the supervisor
  under its existing local `LOCAL_READER_DEVICE_TOKEN` transport key. This
  learning credential authorizes only `/api/course-discovery/*`; it never
  replaces or authorizes the installed Local Reader's `/api/local-reader/*`
  credential. Only an absent dedicated server setting retains the old-token
  migration fallback; a configured empty or invalid setting fails closed.
  Never put either credential in a command transcript,
  receipt, repository or model prompt. The API authenticates requests with
  body-bound HMAC signatures and timestamp validation.
- Select `COURSE_DISCOVERY_BROWSER_TRANSPORT=PINNED_HTTP` or `NATIVE_CHROME`
  for discovery. The former is the baseline Node fetch path; the latter uses
  Chrome through a temporary public-address-pinned HTTPS tunnel. Both use
  fresh anonymous contexts. A browser recipe saves its transport requirement,
  so later execution does not silently switch methods when this setting changes.
- Leave `COURSE_DISCOVERY_ENABLED` unset until the pilot cohort, release and
  runtime are ready. The ten-minute responder currently supervises legacy
  support only; it does not inspect or restart this supervisor. Enrolled targets
  are excluded from new legacy discovery claims. Existing legacy leases are
  respected and must finish before the new owner can claim.

## Windows supervisor lifecycle

The repository includes a dry-run-by-default current-user Task Scheduler
launcher. It has not registered a task merely because these scripts exist.
Choose a maintained, stable existing Git worktree with dependencies installed;
moving or archiving that worktree breaks its registered launch path. The task
runs at that user's logon, with a hidden window and limited privileges. It does
not sign the user into Windows or Codex. It retries a failed supervisor process
three times at one-minute intervals; after that bounded limit an operator must
inspect and restart it. It does not create another model agent.

Prepare a JSON configuration file outside every repository, readable only by
the current user, SYSTEM and Administrators. Its ACL must have inheritance
disabled. It must contain exactly `COURSE_DISCOVERY_API_ORIGIN`,
`LOCAL_READER_DEVICE_TOKEN` and `COURSE_DISCOVERY_BROWSER_TRANSPORT`. Populate the
token using the existing local secret mechanism, never a CLI literal, shell
transcript or repository file. The wrapper validates this file without printing
its values, and passes credentials only in the supervisor process environment.

Review the registration plan first, with real absolute paths substituted:

```powershell
.\scripts\automation\manage-course-discovery-task.ps1 -Action Register -WorkspacePath '<stable-worktree>' -ConfigPath '<protected-external-json>'
```

After the normal release and activation gates, repeat that command with
`-Apply` to register. Registration does not start it immediately; use `-Action
Start -Apply` for the initial run. `-Action Inspect` is read-only. `Start`,
`Stop`, `Disable` and `Uninstall` are dry runs unless `-Apply` is supplied. The
script inspects the exact existing task name and refuses to overwrite a task
without its managed marker.

The default log directory is `logs` beside the protected configuration file;
`-LogDirectory` can select another external directory. The wrapper writes only
projected JSON events and model/runtime metrics to a UTC-dated `.jsonl` file,
capped at 8 MiB per day. Unstructured diagnostics are replaced with a generic
code. Inspect reports the latest heartbeat age, last poll outcome and readiness
from Task Scheduler state plus those local logs, without calling a provider.
A fresh heartbeat proves the local loop is alive; it does not prove provider
coverage, successful delivery or the three-alert acceptance result.

Before enabling unattended production use, update the existing ten-minute
recovery automation through its supported automation API to inspect this
health/queue evidence before its legacy no-action exit. That activation step
has not been performed here. The recovery task must not create a second
supervisor while the managed task is running, reset job deadlines or send email.

See [execution limits](course-discovery-execution-limits.md) before interpreting
a successful local browser fixture as evidence of live provider support.

## Blind selection and acceptance

The independent observer prepares a JSON candidate catalog using current,
public availability and configuration evidence. Candidate records include
`id`, `name`, `kind`, `providerFamily`, `countryCode`, `officialUrl`,
`unconfigured`, `inventoryVerified`, `inventoryEvidenceUrl` and
`inventoryObservedAt`. Optional `excludedReason` is retained in the receipt.
The observer keeps provider routes, selectors, payloads and configuration out
of the worker's inputs.

Run the read-only selector before enabling the cohort:

```powershell
node scripts/automation/select-course-discovery-pilot.mjs --catalog <observer-catalog.json>
```

Save its JSON receipt outside the repository. It records the random seed,
complete ordered draw, every exclusion and the first feasible triple. The
triple must contain both an outdoor course and a simulator, three distinct
identified provider families, fresh verified inventory, and no configured source.
Golf Cove, One Golf Haven and Tashua are development cases and are excluded.
Do not reroll a difficult selection; record its outcome or exclusion.

Enable the preconfigured three-target cohort before the user creates its
normal alerts. Automatic enrollment must be bounded to the selected owner and
targets, persistent, and limited to three lifetime enrollments. Existing exact
`COURSE_DISCOVERY_PILOT_SEARCH_IDS` are available for development/recovery, but
adding IDs after alert creation is not a blind acceptance run.

The following automatic-enrollment configuration belongs to the deployed
application environment. Do not add these keys to the protected local JSON;
that file accepts only the three supervisor keys listed above.

```text
COURSE_DISCOVERY_ENABLED=true
COURSE_DISCOVERY_PILOT_OWNER_USER_ID=<exact internal User.id>
COURSE_DISCOVERY_PILOT_TARGET_KEYS=course:<id>,offering:<id>,course:<id>
```

Release the code initially with `COURSE_DISCOVERY_ENABLED=false`, after the
additive migrations have passed on the isolated database and been applied
through the authorized release path. Verify the disabled deployment, then set
the bounded owner/target configuration and enable it in a new deployment for
the pilot. Changing a Vercel environment value does not update a running
deployment. Verify the intended live commit and configuration before starting
the local supervisor or creating the three alerts.

Use the actual selected mix of course and offering keys. Leave
`COURSE_DISCOVERY_PILOT_SEARCH_IDS` empty in this mode; a nonempty explicit-ID
setting takes precedence. Each ordinary alert must contain one selected target.
Enrollment runs inside its normal creation transaction, under an owner row
lock. Its append-only receipt binds the owner, configuration cohort, target,
search ID and one of three slots. Deleting an alert does not refund a slot.
Changing date, time, duration or players preserves enrollment; changing the
target leaves the pilot. The observer's inventory evidence and recipe details
are never placed in this runtime configuration.

For genuinely new venues that have no `Course` or `CourseOffering` row yet,
use `place:<GooglePlaceId>:OUTDOOR` or `place:<GooglePlaceId>:SIMULATOR` instead.
The ordinary create transaction resolves the course/offering, then matches its
saved Google Place identity and mode to the preconfigured key. No pre-created
database venue or post-creation configuration edit is required. Do not include
both an internal key and a Place key for the same target; ambiguous matches
are rejected.

For the acceptance run:

1. Start the supervisor with logs saved outside the repository. The user creates
   the three ordinary alerts. No source hints, configuration edits, worker
   nudges or completion commands are permitted after admission.
2. Record job IDs, immutable first pickup, every attempt, browser startup,
   provider requests, discovery/replay duration, CLI/model versions, token
   usage, activation, match persistence and outbox acceptance timestamps.
3. The user confirms the received matching alert and receipt time. Never mark
   inbox success from an outbox `SENT` row or manually send an email.
4. Stop and restart the supervisor, change the alert parameters through the
   ordinary UI, and verify all three execute their persisted recipes. Confirm
   zero new discovery jobs and zero model calls for these warm checks.
5. Include same-provider concurrency, killed worker / expired lease recovery,
   duplicate results, source drift, edited/cancelled alerts, unavailable Chrome
   and vanished inventory in the final receipt. Keep failures and exclusions.

The target is five minutes and the maximum is fifteen from first pickup to
received matching email, on all three unseen venues. A setup/status email without matching times,
successful replay, green test, deployment or closed incident is insufficient.

For a read-only database receipt, use:

```powershell
npm run automation:inspect-course-learning -- --hours 24 --limit 10
```

An optional repeated `--job-id` selects exact jobs. The receipt includes
pickup/deadline timestamps, recipe identity, recent warm executions and
matching-email acceptance, including a setup email that contains matching
times. It omits recipients, secrets and raw browser data. Add the supervisor's
version/token/timing log and the owner's received-at confirmation before
evaluating the fifteen-minute acceptance requirement.

## Rollback

Stop and disable the local supervisor immediately with `-Action Disable
-Apply`, then publish a deployment with `COURSE_DISCOVERY_ENABLED=false`.
Changing the stored environment value alone does not disable the running
application. The disabled deployment stops new admission and recipe selection.
These actions preserve saved demand, recipes,
attempt history and verification evidence. Existing search Workflows and the
legacy responder remain the product's scheduling and recovery mechanisms.
The legacy responder does not currently recover learned jobs. The managed
task must stay disabled until the pilot is deliberately resumed.
Uninstall removes only this managed task.
Do not delete customer alerts or reset attempt clocks to make the pilot pass.

## Local verification

Use only the disposable localhost `course_discovery_test` database for the
Postgres tests; the suites reject other hosts/database names. Apply migrations
with the local connection explicitly selected, then run the stateful suites
serially so their independent fixtures do not claim each other's global queue:

```powershell
$env:COURSE_DISCOVERY_TEST_DATABASE_URL = '<isolated localhost URL>'
npx vitest run src/lib/course-discovery --no-file-parallelism
```

These tests mock email transport. They verify database and outbox behavior
without delivering to customers. The ordinary full suite skips database tests
when the explicit test URL is absent.
