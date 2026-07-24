# CPS local Chrome reader

This worker separates a backend job from a local, rendered-page read:

```text
signed backend job -> local Chrome page -> normalized slots -> signed backend result
```

It reads only exact, allowlisted, signed-out CPS tee-time search routes. It
normalizes rendered start time, hole options, public golfer capacity, price, and
cart labels from both current and legacy CPS card layouts. It does not inspect
cookies or browser storage, call private provider APIs, click a tee time, sign
in, enter a cart, or continue to checkout.

The current allowlist includes Grassy Hill, Overpeck, Glen Mills, Bayberry Hills,
Oak Lane, Candia Woods, Oxford Greens, Shennecossett, Stanley, Colonie,
Springfield Township, Pine Hollow, and Capital Hills. Fenwick is deliberately
excluded because its public route redirects to email verification.

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
   an inactive tab only when a signed allowlisted CPS job is waiting.

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
