# Browser Reader Evaluation and Monitoring Strategy

Last reviewed: 2026-07-23 America/New_York

## Goal

Increase the number of public courses Tee Time Spot can monitor without turning
the product into a booking bot or treating a browser as a universal scraper.
The system reads official, public, signed-out availability and sends golfers to
the official site to book.

Never enter login, checkout, reservation, payment, verification-code, CAPTCHA,
Turnstile, waiting-room, or queue-gated flows. A standard browser may execute
ordinary page JavaScript to learn public provider metadata, but it stops when
an access control is observed.

## Controlled Local Results

These tools were tested only against a synthetic local JavaScript/cookie page.
No test targeted Shennecossett, CPS, Cloudflare, Turnstile, or another protected
third-party service. Passing the lab proves JavaScript execution and cookie
persistence, not real-site challenge success.

| Tool | Lab result | Cost/license | Product assessment |
| --- | ---: | --- | --- |
| Plain Node HTTP | Did not execute the JavaScript redirect | Free | Correct first transport for APIs and server-rendered pages |
| FlareSolverr | Passed in 1.43s | MIT, free | Simple Docker API, but challenge-signature dependent |
| CloudflareBypassForScraping | Passed in 7.10s | MIT, free | Fortified but heavy and challenge-oriented |
| Byparr | Passed in 2.51s | GPL-3.0, free | Packaged Camoufox; about 1.18 GiB image and 414 MiB test memory |
| Zendriver 0.15.5 | Passed in 1.35s | AGPL-3.0, free | Fast, but separate Python runtime and license are poor deployment fits |
| Undetected ChromeDriver 3.5.5 | Passed in 3.31s | GPL-3.0, free | Needed a Python compatibility package, leaked `HeadlessChrome`, and emitted a shutdown warning |
| SeleniumBase UC Mode | Passed; 12.56s cold start | MIT, free | Actively maintained but large; its docs warn that headless UC is detectable |
| Camoufox | Passed; 10.24s cold start | MPL-2.0, free | Coherent Firefox fingerprint; required an approximately 492 MB browser download |
| Puppeteer Core | Passed in 0.67s | Free | Exposed several normal headless signals |
| Puppeteer-extra stealth | Passed in 0.83s | MIT, free | Removed obvious lab signals, but its published plugin is roughly three years old |

References:

- [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)
- [CloudflareBypassForScraping](https://github.com/sarperavci/CloudflareBypassForScraping)
- [Byparr](https://github.com/ThePhaseless/Byparr)
- [Zendriver](https://pypi.org/project/zendriver/)
- [Undetected ChromeDriver](https://github.com/ultrafunkamsterdam/undetected-chromedriver)
- [SeleniumBase UC Mode](https://seleniumbase.io/help_docs/uc_mode/)
- [Camoufox](https://github.com/daijro/camoufox)
- [Puppeteer-extra stealth](https://www.npmjs.com/package/puppeteer-extra-plugin-stealth)

The software is free, subject to its license. A continuously running browser
worker still needs compute. Entry public VMs start near $4 to $5 per month, but
2 to 4 GiB RAM makes approximately $12 to $24 per month a more credible browser
worker baseline. Proxy rotation is a separate cost and was not tested.

## Production Baseline

Read-only `automation:course-support -- coverage` evidence at
2026-07-23 23:18 America/New_York:

| Category | Courses |
| --- | ---: |
| Persisted | 175 |
| Eligible public | 139 |
| Effectively monitored | 96 |
| Supported, awaiting proof | 2 |
| Technical constraint | 21 |
| Phone or walk-in | 16 |
| Unsupported family | 4 |
| Private or invalid | 36 |

Effective eligible-course coverage was 69.1%. TeeItUp was 39/39 monitored,
ForeUP 28 monitored plus one ready out of 30, Chronogolf 11/14, CPS two
monitored plus one ready out of 13, and Teesnap 5/5. The live reusable gap was
small: four unsupported-family courses, led by TenFore, plus isolated unknown
source incidents. Most non-monitored eligible courses had verified technical or
manual-booking dispositions, not missing browser capability.

The new strategy report recommended 98 typed-adapter runs, two bounded HTTP
discoveries, and two reusable provider-adapter repairs. It recommended zero
browser-discovery jobs from the current snapshot: no course had first exhausted
the HTTP discovery step. The remaining rows stayed in their 21 current
technical, 16 manual-booking, and 36 private/invalid final dispositions.

## Implemented Decision Ladder

`src/lib/automation/monitoring-strategy.ts` selects one explicit action:

1. `RUN_TYPED_ADAPTER` for validated provider metadata.
2. `DISCOVER_WITH_HTTP` for a missing or conflicting source.
3. `DISCOVER_WITH_BROWSER` only after direct HTTP is inconclusive.
4. `VERIFY_TECHNICAL_CONSTRAINT` for a new authentication or challenge
   observation; the standard browser stops at the access control.
5. `RETRY_PROVIDER` for bounded rate-limit, provider 5xx, timeout, or network
   failures.
6. `REPAIR_PROVIDER_ADAPTER` for schema defects and recognized unsupported
   families.
7. Final technical, manual-booking, and private/invalid actions when current
   evidence supports them.

The browser worker now stops navigation immediately after a 401/403 or strong
managed-access-control signal. It does not click another booking link or fill a
date after that point. Known unsupported families such as TenFore route to one
provider-family repair instead of repeated browser probes.

The aggregate coverage report includes `recommendedActions`, making the next
reusable work visible without exposing course ids, customer data, URLs, or raw
provider responses.

## Why the Production App Does Not Add the Evaluated Stealth Tools

The highest-leverage architecture is:

```text
typed adapter
  -> bounded HTTP discovery
  -> ordinary Playwright discovery when JavaScript is necessary
  -> typed adapter proof
```

Browsers learn stable public tenant/course/provider metadata; recurring
availability reads remain typed, rate-limited adapters. FlareSolverr, Byparr,
Camoufox, UC, Zendriver, and Puppeteer stealth would increase runtime,
maintenance, licensing, and access-control risk without converting the 21
technical constraints or 16 phone/walk-in courses into legitimate monitoring.

## Verification Contract

- Unit-test every strategy transition.
- Prove private/local discovery sources never reach the browser.
- Prove current challenges, queues, manual booking, and private identities are
  final rather than bypass candidates.
- Prove a new challenge observation is verification-only.
- Prove unknown sources use HTTP before browser discovery.
- Prove known unsupported families route to reusable adapter repair.
- Run provider capability, browser discovery, coverage, full tests, typecheck,
  lint, build, UI smoke, and diff checks.
- Claim newly monitored coverage only after a fresh probe from the exact
  deployed runtime returns `MATCH_FOUND` or `NO_MATCH`.
