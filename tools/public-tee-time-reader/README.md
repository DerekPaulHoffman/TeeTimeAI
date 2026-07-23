# Public Tee Time Reader

This is a local-only Chrome DevTools extension for diagnosing public,
signed-out tee-time pages that behave differently in a normal browser than in
the server-side adapter.

It is provider-neutral. The reader observes JSON responses that the inspected
Chrome tab already received, identifies managed challenges such as provider
code `403200`, and extracts common tee-time shapes when the response is
readable. Unknown tee-time JSON is reported as readable so a focused parser can
be added without hard-coding one course or tenant.

The reader does not:

- patch browser fingerprints or hide automation;
- rotate proxies;
- solve CAPTCHA, Turnstile, queues, or managed challenges;
- sign in or inspect authentication responses;
- click, reserve, hold, purchase, or enter checkout;
- send captured data anywhere or change the deployed Tee Time Spot app.

## Load it in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select:
   `C:\dev\TeeTimeAI-public-browser-reader\tools\public-tee-time-reader`
4. Open a public booking page in a normal signed-out Chrome tab.
5. Open Chrome DevTools and select **Tee Time Reader**.
6. Choose **Start reading**, reload the booking page, and use only the public
   date/player filters.

The panel distinguishes:

- **challenge**: the normal tab received a managed challenge or `401`/`403`;
- **tee times**: public tee-time-shaped JSON was readable;
- **readable JSON**: public JSON was readable but no generic slot schema matched.

If a site presents a CAPTCHA or queue, stop. The reader does not complete or
bypass it.

## Test the parser

```powershell
npm run qa:public-browser-reader
```

The copied report contains only sanitized response metadata and normalized slot
fields. Sensitive query values are redacted, raw response bodies are not kept,
and authentication/account/checkout endpoints are ignored.
