# Learn once, run reliably: controlled pilot

This change adds a disabled-by-default discovery path. It is implementation and
test infrastructure, not evidence that three previously unseen venues have
passed the delivery target. The acceptance clock starts at the database's
immutable `CourseDiscoveryJob.firstPickedUpAt`; it ends when the matching message
is observed in the owner's mailbox or the owner confirms receipt. Provider
acceptance is a separate timestamp. A mailbox observation does not by itself
prove inbox placement or human reading.

## Runtime

1. A normal search check keeps established adapters and supported Local
   Reader sources. For an enrolled, unconfigured target it creates or joins one
   durable discovery job.
2. `npm run automation:learn-courses` polls the private API every 15 seconds.
   It runs at most three jobs, while the existing two global / one per-provider
   request leases still control provider traffic. Warm recipe checks have
   priority over new investigations.
3. The normal local controller uses Stagehand4.3.0 with GPT-6.1 Sol through the
   existing ChatGPT sign-in. Its source-only model session has no client tools,
   shell, database, email or activation authority. Stagehand observes and follows
   guarded public navigation for at most120 seconds from the original pickup;
   its sole handoff is one exactly observed official-linked source. A fresh
   fixed reader derives typed adapter metadata and availability independently.
   The trusted controller retains the credential for the private API.
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

A model's `UNSUPPORTED` report ends only its current attempt as an unverified
capability limitation. It does not prove the source is inaccessible or bypass
the one-retry limit and original deadline. A terminal access requirement still
requires a current browser-observed authentication or challenge wall.

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

Enable the preconfigured three-target cohort before the owner, or an agent
expressly authorized by that owner to use the normal product UI, creates its
normal alerts. Automatic enrollment must be bounded to the selected owner and
targets, persistent, and limited to three lifetime enrollments per recorded experiment. Existing exact
`COURSE_DISCOVERY_PILOT_SEARCH_IDS` are available for development/recovery, but
adding IDs after alert creation is not a blind acceptance run.

The following automatic-enrollment configuration belongs to the deployed
application environment. Do not add these keys to the protected local JSON;
that file accepts only the three supervisor keys listed above.

```text
COURSE_DISCOVERY_ENABLED=true
COURSE_DISCOVERY_PILOT_OWNER_USER_ID=<exact internal User.id>
COURSE_DISCOVERY_PILOT_TARGET_KEYS=course:<id>,offering:<id>,course:<id>
# Optional operator-assigned identifier for a separately recorded experiment:
COURSE_DISCOVERY_PILOT_RUN_ID=sol-comparison-20261023-1
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
An absent or blank run ID preserves the original cohort hash and its consumed
slots. A valid run ID is 1–64 lowercase letters, digits or hyphens, beginning
with a letter or digit. Invalid configuration disables automatic enrollment.
Only the operator may select a new run ID before deploying and creating new
ordinary alerts for another authorized experiment. Retain prior enrollment,
job, recipe and delivery evidence; never move an old search into the new run,
change an existing job's pickup or deadline, or rotate target aliases to obtain
another quota. Each run still admits only the exact owner and three targets.
Retries stay within their original experiment and fifteen-minute clock.
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

1. Start the supervisor with logs saved outside the repository. The owner or
   their expressly authorized agent creates the three ordinary alerts through
   the product UI. No source hints, configuration edits, worker
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

### Public simulator reader development evidence (2026-11-02)

Learned GolfBook methods derive the simulator category from the public sheet's
explicit selector. The fixed reader accepts only anonymous date/template HTML
GETs on the two recognized public tenant-host formats. The provider's own
business name, official-site backlink and complete address must match the
canonical venue, and every replay rechecks the selected category and resource
catalog. Darts, karaoke and other activities cannot become simulator matches.
Fifteen- or thirty-minute public cells must cover one complete requested
session on the same bay; each free cell's published timestamp must agree with
the venue-local row clock. Unknown or changed grids remain incomplete. Generic
synthetic fixtures exercise this method; the new acceptance venues are kept
out of those fixtures and receive no provider configuration before admission.

TeeItUp directory reconciliation permits a terminal legal entity suffix in a
course name. It still requires the complete matching address, canonical
timezone, course qualifiers and a unique facility. This does not authorize
discarding conflicting location or timezone facts.

Exact simulator-name lookup may corroborate up to two otherwise eligible hybrid
venues on their current Google-linked official sites. The bounded anonymous
HTML read stays on the same public hostname, uses the provider request leases,
and requires rendered-text simulator and rental/booking evidence. It does not
override closed, private, non-rental or residential classifications. This only
recovers likely identity with unverified rental access; it supplies no booking
route, provider identifiers or availability configuration to discovery. Saving
the alert independently refreshes the same official evidence. An unavailable
confirmation stays unavailable, rather than becoming a verified rental.

The learned-recipe executor now recognizes the Five Iron public simulator
selection route. Discovery binds its public location catalog to the canonical
official branch page, city and timezone. Execution rechecks that binding and
uses only the anonymous public location and availability GETs. The saved
method contains identifiers and bindings, never executable code or credentials.

The provider labels venue wall-clock values with a `Z` suffix; the reader
converts the observed wall time using the venue's IANA timezone rather than
treating that suffix as UTC. One complete requested duration must be offered
by one actual bay. Pooled bays produce one match per interval, and malformed,
partial, changed-identity and inaccessible responses remain incomplete.

A live development replay returned 17 full one-hour intervals for each of two
dates with changed golfer context and zero model calls. This was a developer
protocol check after a failed pilot, with no recipe activation, customer-demand
writes or email sends. It does not establish unattended discovery, durable
persistence, inbox timing or reuse after an actual process restart.

The November 2 Green Woods / Tallwood / Clubhouse Westport cold cohort passed
only one of three targets. Green Woods persisted its method and 51 matches;
its matching email reached Gmail 129 seconds after first pickup. Tallwood
incorrectly accepted the venue's separately named simulator tenant as its
outdoor source. Clubhouse's independent replay rejected a wall-clock epoch
as though it were an absolute instant. The original deadlines and failed
outcomes remain preserved. This is not three-venue acceptance or restart proof.

Outdoor TeeItUp routing now excludes explicitly named simulator/indoor tenants,
and fixed execution rejects those tenants even when an older directory flag
labels them outdoor. Other names, complete addresses and timezone checks remain
required. GolfBook verifies its published wall-clock epoch against the displayed
date/time, then converts the resulting opening with the venue's IANA timezone.
Focused winter/summer and wrong-template/time tests guard the conversion. A
developer replay found 101 full-hour intervals on November 5 and 40 on November
6, with changed golfer context and zero model calls. That replay did not
activate a production recipe, save demand or send email.

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

The subsequent November 2 Rolling Meadows / Simulators at MCC / Two Roads
cohort failed all three targets after their two automatic attempts. No method,
canonical match or matching email was saved. Setup emails reached Gmail but
do not count as matching alerts. The jobs retain their original pickup clocks;
the test alerts were paused after terminal observation, without source hints,
manual job actions or runtime changes during the run. This cohort was screened
in advance and randomized only in run order. Two Roads had a basic catalog
identity but no prior executable configuration, job or recipe. It is not a
statewide random sample or acceptance evidence. Recorded model usage was at
least 135,378 tokens, including the unsuccessful generic fallback.

MCC's public informational link says "Reserve a Simulator now!". Source-only
navigation now accepts that bounded caption variant under the existing current
document, plain anchor, safe destination and transaction exclusions. Native
anchor input returns without Playwright's implicit navigation wait; the source
controller still independently observes navigation and document completion.
A real isolated Chrome test leaves a target response pending and verifies one
click returns without claiming a completed page. These focused fixes do not
establish repaired live discovery, three matching emails or restart reuse.

The follow-up repair on the same three venues also failed all targets; it was
not a new-venue acceptance run. It recorded at least 172,425 worker tokens and
produced only setup emails. Both failed cohorts and their original jobs remain
preserved; their dashboard alerts were paused after each terminal observation.

Local reproductions now exercise the actual guarded Stagehand browser with no
model, provider or production calls. A hanging ancillary script previously
prevented the next public document from loading. The controller stops that
completed source's old loading before clicking, awaits the old reads and their
leases, and recaptures the unchanged document and link. Stopping the successor
after clicking, or releasing a lease while its request is live, is excluded.

A public entry link before a later business-hours section is no longer treated
as an individual time merely because its whole article contains opening hours.
This source-only exception retains preceding context, slot/date headings,
ordinary booking-row checks and the existing plain-link destination guards.
Separate positive and negative DOM fixtures cover the distinction.

A late request belonging to a retired loader retains its tombstone and original
pause until an abort acknowledgement or the exact independent network terminal
arrives. A prior correlated terminal can settle the same pause without issuing
an invalid second abort. Both event orderings are tested; an unrelated terminal
still times out. These local fixes require fresh live verification and do not
change either failed result into acceptance or saved-method restart proof.

Two later development repairs on the same venues also failed all targets. The
first stopped before any model call or page inspection during guarded-host
startup. Windows memory pressure was observed afterward; its cause was not
established. Three parallel isolated browser/Stagehand/ChatGPT startup checks
subsequently passed without terminating unrelated processes or changing runtime
configuration. Startup readiness is separate from reliable discovery.

The next repair reached source discovery and fixed inspection, but produced no
recipes, canonical matches or matching emails. Its recorded worker usage was at
least 242,912 tokens, including unsuccessful generic fallbacks. All twelve
original failed jobs and pickup clocks remain preserved; the three alerts were
paused after terminal observation. This is development evidence, not an unseen
cohort or restart-reuse pass.

A deterministic, model-disabled Two Roads reproduction identifies a delayed
21+ age-confirmation overlay on the brewery homepage as the click blocker. An
early click before it appears is not reliable access evidence. No age assertion
was made. Complete one-hour bay inventory also remains unverified there.

Two further local corrections address independently reproduced transport
failures. Retired response interceptions can expire before their exact native
network failure arrives; the controller now accepts either the real abort ACK
or that correlated failure within the existing bound, without reading the
response or admitting a successor. Foreign and revised identities still fail.
Fixed inspection also advances a canonical-root redirect already traversed by
the fresh browser when its exact completed native redirect chain attests it;
the destination need not appear again as a page link. Missing or foreign
redirect attestations remain rejected. These corrections require live proof.

The next bounded CT draw selected Sterling Farms, Oxford Greens and KG Elite.
It has not passed acceptance: KG's ordinary legacy Acuity link was treated as
an iframe, Sterling's public Chelsea surface was unsupported, and Oxford's
recognized old CPS URL bypassed learning and returned no matches despite a
current official Chronogolf migration. The original jobs/clocks and explicit
selection exclusions remain preserved outside the repository. Sterling also
has a basic identity-only demo fixture; this limitation is disclosed rather
than claiming completely fixture-blind sampling.

Source routing now distinguishes a freshly witnessed iframe from an ordinary
visible link with the same URL shape. A completed ordinary Acuity click can
expose its actual same-origin public calendar through the existing paired
native document ledger; no opaque calendar key is inferred. Identity,
inventory and independent replay still belong to the fixed inspector.
An unconfigured dynamic local-reader URL is no longer an established saved
method merely because its syntax matches a parser. Typed supported adapters,
the two explicit static readers and LOCAL_READER_ONLY retain their routes.
These fixes require live verification; they do not establish Chelsea support,
three received matching emails or changed-parameter restart reuse.

KG development now reaches the public calendar through Stagehand in 22 seconds.
The fixed reader independently replays nine full one-hour openings on each of
two dates in under five seconds total with the model disabled. This remains
local development evidence: nothing was activated in Postgres or emailed.
The Acuity reader now recognizes an exactly duration-labelled golf simulator
whose public plain description explicitly identifies a single bay available
for hourly rental, bound to its one attached Golf Simulator calendar and
timezone. Prepaid products, private/class services, unknown calendars and
duration mismatches remain excluded. Acuity-only company-name normalization
permits an omitted terminal Co./Company without dropping brand/location words
or changing the canonical name, address, timezone, owner or rental identifiers.
