# Grassy Hill local Chrome reader

This proof separates a backend job from a local, rendered-page read:

```text
signed backend job -> local Chrome page -> normalized slots -> signed backend result
```

The reader accepts only Grassy Hill's public CPS tee-time search route. It reads the
rendered tee-time card's local start time, hole options, public golfer capacity,
price, and cart label. It does not inspect cookies or browser storage, call private
provider APIs, click a tee time, sign in, enter a cart, or continue to checkout.

## Run the local proof backend

Set a temporary device token without committing it, then start the loopback-only
server:

```powershell
$env:LOCAL_READER_DEVICE_TOKEN = '<at-least-16-random-characters>'
npx tsx tools/local-chrome-reader/mock-backend.ts
```

The proof backend binds only to `127.0.0.1:4317`. It keeps jobs in memory and exists
to verify the signed job, lease, rendered-page result, and completion flow. It is
not a production queue and does not write tee-time matches or send alerts.

## Install the production worker

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select this `tools/local-chrome-reader` folder.
3. In the options page, enter the device token configured as
   `LOCAL_READER_DEVICE_TOKEN` in production, check **Enable polling**, and save.
4. Leave Chrome running. The extension polls outbound once per minute and opens an
   inactive Grassy Hill tab only when a signed job is waiting.

The production backend persists short-lived jobs and leases in Neon. The extension
signs every request with HMAC-SHA256 and accepts jobs only for Grassy Hill's exact
public booking route. A completed read requeues the normal search workflow, which
owns match persistence and alert email delivery.

## Security and product boundary

The home machine polls outbound; the backend never opens an inbound connection to
the machine or submits arbitrary URLs, prompts, or commands. The reader does not
inspect cookies or browser storage, sign in, choose a tee time, enter a cart, book,
reserve, pay, or continue to checkout. Chrome must be running and the extension
enabled when a local-reader job is queued.
