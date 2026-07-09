# Deployment Status

Last updated: 2026-07-08

## Live Vercel Deployment

- Project: `teetimeai`
- Production URL: `https://teetimespot.com`
- Alternate domain: `https://www.teetimespot.com`
- Previous Vercel domain: `https://teetimeai.vercel.app`
- Latest verified deployment: `teetimeai-l957er0a5-derekpaulhoffmans-projects.vercel.app`
- Deployment ID: `dpl_BseBpUfu6Pc2gHHMqGFEdVntWcPT`
- Vercel project ID: `prj_dI6LhLrDCSq06xgvtNvaKtF6Uz7Y`
- Vercel team/account ID: `team_qS5jqFYAovuxspGMzno0XtdK`

## Verified

- `npm run test:run`
- `npm run lint`
- `npm run build`
- Production Vercel deploy completed successfully.
- `teetimespot.com` was purchased through Vercel, attached to the `teetimeai` project, and verified.
- `www.teetimespot.com` was attached to the same project and verified.
- Clerk production instance exists for `teetimespot.com`; DNS, SSL, and Clerk mail DNS are complete.
- Resend free marketplace resource `teetimespot-alerts` is connected to Vercel. The `teetimespot.com` sending domain is verified with sending enabled.
- Resend production, preview, and development env vars include `RESEND_API_KEY`, `RESEND_EMAIL_DOMAIN`, and `ALERT_EMAIL_FROM`.
- Resend smoke sent successfully to `delivered@resend.dev` using a restricted sending key and fixed idempotency key.
- Neon Postgres marketplace resource is connected, migrated, and seeded with the ForeUP demo adapter data.
- Live `/` returns 200 and renders the Tee Time Spot intake.
- Live `/dashboard` returns 200. Signed-out users see the account-management prompt instead of a missing sign-in route.
- Live `/api/location/geocode?q=Trumbull%2C%20CT` returns 200 with Google Places text-search coordinates and `demo=false`.
- Live `/api/courses/discover?latitude=41.242&longitude=-73.209&radiusMeters=30000` returns 200 with 20 live Google Places courses and `demo=false`.
- Live `/api/courses/photo` returns a 302 redirect to a Google-hosted course image when Places returns `photoName`.
- Live `POST /api/searches` accepts an alert email plus 1 to 5 ranked courses and creates an active search in Postgres.
- Live `/api/automation/active-searches` returns 200 with the configured `x-automation-key`; latest smoke saw 9 active searches in the queue.
- Playwright browser smoke verified desktop course discovery, ranking, email-alert save, dashboard rendering, mobile layout, and zero browser console errors.
- Vercel runtime log scan found no errors after the final deployment; latest entries were 200/201 info logs for `/`, `/api/automation/active-searches`, and `/api/searches`.
- 2026-07-08 hourly product loop: repaired 3 active preferences that pointed at an unsupported duplicate Tashua Knolls row, then reran `npm run automation:poll`; latest run processed 8 active searches with 10 `NO_MATCH` probes and 0 `NEEDS_ADAPTER` probes.
- 2026-07-08 live smoke found Google Places returning 502 because the production API key value included a leading BOM character; Google Places clients now normalize copied env key values before sending headers or photo requests.
- 2026-07-08 production deploy `dpl_AGjhKBkqSAaxBaRK5eabKDRsAzkt` verified `/` 200, live Google Places geocode/discovery, and `POST /api/searches` with stale Tashua place ID resolving to the seeded `FOREUP`/`ALLOWED` course.
- 2026-07-08 production deploy `dpl_5jp4DbpdFWSAVizS21aFxxyBbdjZ` verified `/` 200, `/dashboard` 200, live Places text geocoding, live Places course discovery, photo proxy redirect, automation auth, and clean Vercel error logs.
- 2026-07-08 hourly product loop added a Postgres advisory lease around `npm run automation:poll` to prevent overlapping pollers from racing pending match alerts. Verification run `cmrco7fz30000iw15h1er63hn` processed 9 active searches and wrote 11 `NO_MATCH` probes with no adapter or fetch failures.
- 2026-07-08 hourly product loop found the local automation shell did not export `DATABASE_URL` or `AUTOMATION_API_KEY`, and found the session-level advisory lock could be orphaned through the pooled Neon/Prisma client. Automation scripts now load ignored local env files without overwriting existing process env, `npm run automation:inspect` prints redacted queue/probe/match health, and the poll lease uses `pg_try_advisory_xact_lock` with a rotated key. Verification run `cmrcqcj8z0000nw15dc3vxboz` processed 9 active searches and wrote 11 `NO_MATCH` probes; no pending alerts remained.
- 2026-07-08 hourly product loop refined `npm run automation:inspect` so `recentActionableProbes` reports only the latest unresolved probe state for each active search/course, while historical non-`NO_MATCH` events remain under `recentNotableProbes`. Verification run `cmrcsge260000z815f0hngog5` processed 9 active searches, latest inspect showed 0 current actionable probes and no pending alerts, and the intake default date now formats as a local calendar date instead of UTC.
- 2026-07-08 production deploy `dpl_BseBpUfu6Pc2gHHMqGFEdVntWcPT` verified `/` 200, `/dashboard` 200, live Places geocode, automation auth, and production Playwright intake rendering with the local-tomorrow date value and no failed resources.

## Current Runtime Mode

The public site is live as an email-alert proof of concept:

- Nearby discovery uses Google Places in production and falls back to demo course data only when `GOOGLE_PLACES_API_KEY` is absent.
- Google Places course thumbnails are implemented through `/api/courses/photo` and activate when live Places data returns `photos`.
- Google Places nearby search, text geocoding, and photo requests all use the same normalized API key value. The separate Google Geocoding API is not required for the current typed-location flow.
- Saved searches can still be stored in Neon by alert email for signed-out visitors.
- Search creation now reuses an existing supported nearby course row before creating a new course, so alternate demo/place IDs do not drop ForeUP adapter metadata.
- Clerk production keys are set in Vercel, but the app keeps Clerk disabled until `CLERK_AUTH_READY=true` because Google OAuth production credentials are still missing.
- Dashboard management actions require a signed-in Clerk account after Clerk auth is marked ready.
- Email sending is live through Resend when `RESEND_API_KEY` and `ALERT_EMAIL_FROM` are present. Local/automation runs still dry-run if those vars are absent.

## Remaining Provider Setup

- Clerk production: domain, DNS, SSL, mail DNS, and production keys are complete. Remaining blocker is Google OAuth production credentials. `clerk deploy status` reports `oauth_pending` for `google`; configure a Google OAuth client or disable Google OAuth in Clerk, then set `CLERK_AUTH_READY=true` in Vercel production and redeploy.
- Google Maps key hygiene: Places API (New) is enabled and `GOOGLE_PLACES_API_KEY` is configured in Vercel. The current key was shared in chat during setup, so restrict it to the needed Google APIs and rotate it after confirming production remains healthy.
- Resend: core sending is configured. The original marketplace-managed API key cannot be deleted through the Resend API; manage/remove it from the Vercel Marketplace dashboard if a full cleanup is needed.
- Automation auth: `AUTOMATION_API_KEY` is set in production and local `.env.local`; keep it secret and rotate if exposed.
- Automation worker: local scripts load ignored env files automatically for operator runs, but hosted/scheduled workers should still provide env vars through the runtime rather than relying on checked-in files.

## Notes

- `npm run build` runs `prisma generate` before `next build` so clean Vercel builders have Prisma client types available.
- `.vercel/` and local env files are intentionally ignored. Do not commit provider credentials.
- The Codex loop remains alert-only and must not enter checkout, payment, verification-code, or account-specific booking flows.
