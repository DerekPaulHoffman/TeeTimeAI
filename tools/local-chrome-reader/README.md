# Local Chrome tee-time reader

This worker separates a backend job from a local, rendered-page read:

```text
signed backend job -> local Chrome page -> normalized slots -> signed backend result
```

It reads only signed backend jobs for exact, signed-out CPS tee-time search
routes, exact TenFore tenant routes, safe public Chronogolf club profiles,
safe one-label EZLinks tenant search pages, safe one-label MyVSCloud WebTrac
golf-search pages, and the exact Frear Park and Simsbury Farms legacy Prophet
tee sheets. CPS
tenants are accepted automatically only when the URL
is HTTPS, uses one `*.cps.golf` tenant host, and stays on
`/onlineresweb/search-teetime`. TenFore tenants are accepted only on
`fox.tenfore.golf/<tenant>` with the signed job's exact tenant and date. It
normalizes rendered start time, hole options, public golfer capacity, price,
and cart labels from current and legacy CPS card layouts, TenFore's public
cards, and Chronogolf's public tee-time cards. It does not inspect cookies or
browser storage, call private provider APIs, click a tee time, sign in, enter a
cart, or continue to checkout.

New CPS tenants do not require an extension release or a course-specific
allowlist entry. Authentication, email verification, CAPTCHA, queue, unexpected
redirect, and unrecognized page shapes still fail closed and return evidence
instead of being bypassed.

New TenFore tenants use the same rendered-card parser only when the exact signed
job URL remains on `fox.tenfore.golf`, contains one safe tenant path, and renders
the requested date. The local reader never generates, reads, or replays
TenFore's underlying CAPTCHA token.

Chronogolf pages are accepted only on the public `chronogolf.com/club/<slug>`
route with one safe slug. Those pages are opened with a date, tee-time step,
and public player-count selection; unrelated paths and unexpected page shapes
fail closed. A newly discovered safe public club profile can therefore use the
existing generic parser without a course-specific extension release.

EZLinks pages are accepted only on an HTTPS, one-label `*.ezlinksgolf.com`
tenant and the exact rendered `index.html#!/search` route. The reader uses the
public date and player controls, verifies the rendered course and date, and
normalizes only the visible result cards. Cloudflare verification is never
bypassed: a challenge remains an explicit access result, and the reader never
calls or replays transaction endpoints.

MyVSCloud WebTrac pages are accepted only on an HTTPS, one-label
`*.myvscloud.com` tenant and the exact `/webtrac/web/search.html` route. The
signed job supplies only the target date, public player count, detail display,
and golf-search parameters. The reader normalizes visible result-table rows,
returns the stable public search URL, and never clicks Add To Cart or reads a
session token.

Legacy Prophet jobs use only the exact public rendered tee sheet, course IDs,
date, player count, and 18-hole filter recorded for Frear Park or Simsbury
Farms. The reader ignores session-bearing links on individual tee-time cards,
returns the stable public search URL, and never clicks a tee time or enters the
transaction flow.

## Place in the monitoring playbook

The local reader is the last automatic path, not the preferred path for CPS,
Chronogolf, or another normally runnable provider. A new or materially changed
course first receives official identity validation, typed-adapter execution,
bounded official HTTP discovery and adapter retry, then ordinary Playwright
discovery and another adapter retry. Only an unresolved course with a safe,
compatible reader capability reaches this worker. Independent confirmation
follows the reader result.

Each reader attempt has one five-minute window. The backend distinguishes an
active job, a successful completed job, and a terminal completed job. A
completed `ACCESS_CHALLENGE`, `PAGE_MISMATCH`, or `READER_ERROR` remains terminal
evidence for that attempt and must never be shown or queued again as
`CHECK_PENDING`. It is not by itself an automatic technical final: technical
finality also requires the complete current playbook and a matching independent
current observation. Otherwise the course enters human review at the truthful
30-minute endpoint and its alert remains active for six-hour safe rechecks.

## Run the local proof backend

Set a temporary device token without committing it, then start the loopback-only
server:

```powershell
$env:LOCAL_READER_DEVICE_TOKEN = '<at-least-16-random-characters>'
npx tsx tools/local-chrome-reader/mock-backend.ts
```

The proof backend binds only to `127.0.0.1:4317`. It keeps jobs in memory and
exists to verify the signed job, lease, rendered-page result, and completion
flow. It is not a production queue and does not write tee-time matches or send
alerts. POST `/jobs` accepts `courseKey`, `targetDate`, and `players`;
`courseKey` defaults to `cps:grassyhill.cps.golf`.

## Install the production worker

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select this `tools/local-chrome-reader` folder.
3. In the options page, enter the device token configured as
   `LOCAL_READER_DEVICE_TOKEN` in production, check **Enable polling**, and save.
4. Leave Chrome running. The extension polls outbound once per minute and opens
   an inactive tab only when a signed allowlisted reader job is waiting.

The worker reports its build and parser capabilities with every poll. The
backend leases only compatible work and automatically requeues exact
verification when a required capability appears. CPS, TenFore, Chronogolf,
EZLinks, and WebTrac course identity and booking URLs come from the signed
database-backed job and are checked against provider-family host and route
rules. Courses that fit an existing parser do not require a course-specific
allowlist entry or extension release.
An actual parser or manifest change to this unpacked development extension
still requires Chrome's **Reload** action; unattended binary updates require a
separately signed Web Store or enterprise-managed extension package.

The production backend persists short-lived jobs and leases in Neon. The
extension signs every request with HMAC-SHA256 and accepts only jobs whose
required parser capability, course key, course name, card filter, host, and
route match its bounded public-route rules.
A completed read requeues the normal search workflow, which owns match
persistence and alert email delivery.

The worker may run two isolated tabs globally. The backend prioritizes active
customer jobs ahead of detached verification and leases no more than one job
for the same provider family at a time. A stalled or failed tab therefore does
not block an unrelated provider job, and each job retains its own lease and
five-minute deadline.

Every compatible signed poll records reader worker health. The expected
heartbeat cadence is two minutes with three minutes of grace, so five minutes
without a compatible reader heartbeat is an operator-visible outage. Each
outage and later recovery is notified once when operator email is configured.
The deployed recovery cron also expires individual reader jobs at five minutes;
job expiry is terminal evidence and never suppresses recovery for searches or
other reader jobs.

## Security and product boundary

The home machine polls outbound; the backend never opens an inbound connection
to the machine or submits arbitrary URLs, prompts, or commands. The reader does
not inspect cookies or browser storage, sign in, choose a tee time, enter a cart,
book, reserve, pay, or continue to checkout. Chrome must be running and the
extension enabled when a local-reader job is queued.

The reader never solves or bypasses CAPTCHA, Turnstile, Cloudflare, login,
waiting-room, or queue controls and never replays challenge tokens. Do not pair
it with stealth drivers, proxy rotation, CAPTCHA solvers, FlareSolverr, or a
browser-bypass vendor. Ordinary page JavaScript and a bounded passive wait are
allowed; a persistent access control is returned as evidence.
