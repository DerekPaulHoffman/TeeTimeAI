# Simulator alerts

Simulator mode discovers public venues with rentable golf simulator bays, saves
ranked demand for one bay and a session duration, and sends official booking
links when a complete matching session is observed. The golfer books on the
official site. Tee Time Spot never selects a slot, holds inventory, reserves,
pays, enters checkout, or sends an email on an operator's behalf.

The feature is disabled unless `SIMULATOR_MODE_ENABLED=true`. Apply both additive
database migrations and verify their readback before deploying code that queries
`CourseOffering`; enable the feature only after the deployed provider path has
been verified. Existing requests and searches default to `OUTDOOR`.

## Identity and access

`Course` remains the shared physical venue identity. Its public-course status,
outdoor booking link, layout, provider metadata and monitoring health retain
their existing meaning. `CourseOffering` owns each venue's `OUTDOOR` or
`SIMULATOR` offering. Simulator public rental access, official simulator URL,
party capacity, supported durations, booking window, provider configuration and
monitoring evidence are separate facts.

An outdoor `VERIFIED_NON_COURSE` simulator correction remains effective outdoors.
It does not negate independently reviewed public simulator rentals. A private
room or bay is not a members-only business. Lessons, fittings, equipment sales,
miniature golf and driving-range products do not establish rentable simulator
inventory. Public simulator discovery may display unverified venues, but saving
an alert requires a canonical verified offering, confirmed capacity and a
supported duration. Client-supplied capability labels do not authorize saving.

## Discovery and caching

`/api/courses/discover` and `/api/courses/lookup` accept
`mode=OUTDOOR|SIMULATOR` and retain the `courses[]` response envelope. Simulator
results carry mode, offering ID and reviewed rental capability evidence.
Simulator discovery uses one bounded Nearby query for the
`indoor_golf_course` type and two bounded Text queries. The selected circular
radius is enforced after mapping results. Exact Place IDs and reviewed aliases
identify duplicates; neighboring same-name branches remain distinct.

Simulator cache keys are separate from outdoor keys. Their rental fingerprint
includes identity/access/capability facts, including deactivation, and excludes
monitoring heartbeats and lease state. Current offering health is rebuilt on
each cached response. A provider failure may fall back only to reviewed
simulator offerings in the requested location. No outdoor prices, hole counts,
par, URLs or monitoring readiness are inherited as simulator proof.

Google Nearby returns at most 20 results; Text Search is also bounded here.
Results are useful discovery candidates rather than a promise of a complete
venue census. The website field uses a higher Google billing tier; measure
query counts and cache effectiveness during the pilot.

## Reviewed Connecticut pilot

The operator manifest is [simulator-pilot.json](../scripts/data/simulator-pilot.json).
Every Place ID was retrieved from Google's current exact venue/address search;
no runtime brand registry or invented IDs are used.

| Venue | Current reviewed capabilities | Public reader |
|---|---|---|
| Golf Lounge 18 Canton, Danbury, Fairfield, Orange, South Windsor, Stamford | Six guests per bay; 60–240 minutes in 30-minute increments; official seven-day booking guidance | `GOLF_LOUNGE_18` |
| ZSTRICT at Chelsea Piers, Stamford | Six guests per bay; public template minimum 60 minutes, maximum 360, increment 30; pilot uses 60–240 minutes | `GOLFBOOK` |
| X-Golf Stratford, 345 Hawley Lane | Conservative six-guest capacity from the official venue; explicit 60, 120, 180 and 240 minute products; add-on products excluded | `ACUITY` |

Golf Lounge 18 uses fresh anonymous session cookies and a same-origin CSRF
nonce to read the official public availability endpoint. These are request-local
and never persisted or copied from an account. Every CT location independently
passed the reusable reader for October 10, 2026, a two-hour session and party
of two; each location's product menu/capacity was separately observed.

GolfBook reads the signed-out booking-sheet HTML. It requires the explicit
booking-template duration constraints and contiguous available intervals on the
same bay. Phone-only cells are excluded. Its source epochs encode visible wall
time; the reader converts the requested date and visible time using the venue's
timezone. Neither reserve links nor the page's booking CAPTCHA are invoked.

X-Golf's official booking page embeds its current Acuity tenant. The older vanity
address points to a paused tenant and is not used. Acuity reads the public
availability GET shown in its scheduler code for explicit duration products, including the
provider's pooled `Any Available` resource. A private room is a rental resource,
not evidence of a private-membership venue. The manifest limits party size to six
despite the scheduler's higher value; no add-on duration is inferred as a session.

Public research receipts are stored outside the repository under
`Documents/Codex/2026-10-05/simulator-mode-evidence/`, including
`places-pilot-identities.json`, `gl18-public-offering-contracts.json`,
`gl18-public-read-receipt.json`, `zstrict-http-spike.json`, and
`zstrict-public-read-receipt.json`, and `xgolf-public-read-receipt.json`. These receipts prove provider reads, not a
production migration, deployment, feature activation, Workflow cycle or email
delivery.

## Operator review and local verification

Validate the manifest without accessing the application database:

```powershell
npm run automation:simulator-offerings -- --manifest scripts/data/simulator-pilot.json
```

Applying is explicit and checks the loaded database's hostname. Local preview
example, after migration and dry-run inspection:

```powershell
$env:DATABASE_URL = 'postgresql://simulator_preview@127.0.0.1:54348/simulator_preview'
npm run automation:simulator-offerings -- --manifest scripts/data/simulator-pilot.json --apply --expected-database-host 127.0.0.1
Remove-Item Env:DATABASE_URL
```

An explicit `--env-file <path>` can load the reviewed target configuration.
The operator preserves existing venue intelligence; a newly added simulator-only
venue starts excluded from outdoor discovery. Updating an offering revokes its
observation lease, increments its revision and resets monitoring to `UNKNOWN`.
Provider configuration is never taken as proof of runnable monitoring. Secret
fields and credential-bearing URLs are rejected from manifests.

Both pilot migrations are required: `20261005090000_add_simulator_offerings`
adds offering identity and simulator demand; `20261005160000_fence_simulator_match_source`
adds the match's source fingerprint so changed rental configuration cannot reuse
old availability. Historical outdoor matches retain null fingerprints.

The opt-in migration preservation test creates its own local database, applies
all baseline migration SQL, seeds representative old demand and history, then
applies both additive simulator migrations. It verifies default outdoor mode, historical
foreign-key backfill, unchanged existing rows and monitoring, independent hybrid
offerings, uniqueness and referential integrity. It rejects non-local targets
and never deletes the caller's preview database.

```powershell
$env:SIMULATOR_TEST_DATABASE_URL = 'postgresql://simulator_preview@127.0.0.1:54348/simulator_preview'
npx vitest run src/lib/places/simulator-migration.integration.test.ts
Remove-Item Env:SIMULATOR_TEST_DATABASE_URL
```

Database integration uses artificial fixture accounts and never invokes email
transport. Email rendering and delivery behavior must use transport mocks in
tests. Production rollout remains additive migration/readback, code deployment
for the verified Git SHA, fresh simulator reads and application-flow verification,
then deliberate feature activation. Production data changes and release actions
require their own authorization.
