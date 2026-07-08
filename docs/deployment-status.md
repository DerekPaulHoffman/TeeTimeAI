# Deployment Status

Last updated: 2026-07-08

## Live Vercel Deployment

- Project: `teetimeai`
- Production URL: `https://teetimespot.com`
- Alternate domain: `https://www.teetimespot.com`
- Previous Vercel domain: `https://teetimeai.vercel.app`
- Latest verified deployment: `teetimeai-8qqw9we59-derekpaulhoffmans-projects.vercel.app`
- Deployment ID: `dpl_8MEkzqZZtCtTMazgUpPKMbGXFMim`
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
- Live `/api/courses/discover?latitude=41.242&longitude=-73.209&radiusMeters=30000` returns 200 with demo courses while Google Places is not configured.
- Live `POST /api/searches` accepts an alert email plus 1 to 5 ranked courses and creates an active search in Postgres.
- Live `/api/automation/active-searches` returns 200 with the configured `AUTOMATION_API_KEY`; latest smoke saw 7 active searches in the queue.
- Playwright browser smoke verified desktop course discovery, ranking, email-alert save, dashboard rendering, mobile layout, and zero browser console errors.
- Vercel runtime log scan found no errors after the final deployment; latest entries were 200/201 info logs for `/`, `/api/automation/active-searches`, and `/api/searches`.
- 2026-07-08 hourly product loop: repaired 3 active preferences that pointed at an unsupported duplicate Tashua Knolls row, then reran `npm run automation:poll`; latest run processed 8 active searches with 10 `NO_MATCH` probes and 0 `NEEDS_ADAPTER` probes.

## Current Runtime Mode

The public site is live as an email-alert proof of concept:

- Nearby discovery falls back to demo course data until `GOOGLE_PLACES_API_KEY` is configured.
- Google Places course thumbnails are implemented through `/api/courses/photo` and activate when live Places data returns `photos`.
- Saved searches can still be stored in Neon by alert email for signed-out visitors.
- Search creation now reuses an existing supported nearby course row before creating a new course, so alternate demo/place IDs do not drop ForeUP adapter metadata.
- Clerk production keys are set in Vercel, but the app keeps Clerk disabled until `CLERK_AUTH_READY=true` because Google OAuth production credentials are still missing.
- Dashboard management actions require a signed-in Clerk account after Clerk auth is marked ready.
- Email sending is live through Resend when `RESEND_API_KEY` and `ALERT_EMAIL_FROM` are present. Local/automation runs still dry-run if those vars are absent.

## Remaining Provider Setup

- Clerk production: domain, DNS, SSL, mail DNS, and production keys are complete. Remaining blocker is Google OAuth production credentials. `clerk deploy status` reports `oauth_pending` for `google`; configure a Google OAuth client or disable Google OAuth in Clerk, then set `CLERK_AUTH_READY=true` in Vercel production and redeploy.
- Google Places/Geocoding: needs a Google Cloud project with Places API enabled, billing enabled, and `GOOGLE_PLACES_API_KEY` added to Vercel.
- Resend: core sending is configured. The original marketplace-managed API key cannot be deleted through the Resend API; manage/remove it from the Vercel Marketplace dashboard if a full cleanup is needed.
- Automation auth: `AUTOMATION_API_KEY` is set in production and local `.env.local`; keep it secret and rotate if exposed.

## Notes

- `npm run build` runs `prisma generate` before `next build` so clean Vercel builders have Prisma client types available.
- `.vercel/` and local env files are intentionally ignored. Do not commit provider credentials.
- The Codex loop remains alert-only and must not enter checkout, payment, verification-code, or account-specific booking flows.
