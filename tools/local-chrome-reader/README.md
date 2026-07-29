# Local Chrome tee-time reader

This worker separates a backend job from a local, rendered-page read:

```text
signed backend job -> local Chrome page -> normalized slots -> signed backend result
```

It reads only signed backend jobs for exact, signed-out CPS tee-time search
routes, exact TenFore tenant routes, explicitly allowlisted Chronogolf
public club profiles, and Frear Park's exact legacy Prophet tee sheet. CPS
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

The Chronogolf allowlist contains only the exact public profiles owned by
current course-support work, including Lyman Orchards. Those pages are opened
with a date, tee-time step, and public player-count selection; unrelated club
paths and unexpected page shapes fail closed.

Frear Park jobs use only the public rendered tee sheet with an exact date,
player count, both public nines, and 18-hole filter. The reader ignores the
session-bearing links on individual tee-time cards, returns the stable public
search URL, and never clicks a tee time or enters the transaction flow.

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
`courseKey` defaults to `grassy-hill`.

## Install the production worker

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select this `tools/local-chrome-reader` folder.
3. In the options page, enter the device token configured as
   `LOCAL_READER_DEVICE_TOKEN` in production, check **Enable polling**, and save.
4. Leave Chrome running. The extension polls outbound once per minute and opens
   an inactive tab only when a signed allowlisted reader job is waiting.

After pulling a reader update, use the extension's reload button on
`chrome://extensions` so Chrome applies the new manifest and scripts.

The production backend persists short-lived jobs and leases in Neon. The
extension signs every request with HMAC-SHA256 and accepts only jobs whose
course key, course name, card filter, host, and route match its static allowlist.
A completed read requeues the normal search workflow, which owns match
persistence and alert email delivery.

## Security and product boundary

The home machine polls outbound; the backend never opens an inbound connection
to the machine or submits arbitrary URLs, prompts, or commands. The reader does
not inspect cookies or browser storage, sign in, choose a tee time, enter a cart,
book, reserve, pay, or continue to checkout. Chrome must be running and the
extension enabled when a local-reader job is queued.
