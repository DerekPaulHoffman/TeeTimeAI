# Deployment Status

Last updated: 2026-07-08

## Live Vercel Deployment

- Project: `teetimeai`
- Production URL: `https://teetimespot.com`
- Alternate domain: `https://www.teetimespot.com`
- Previous Vercel domain: `https://teetimeai.vercel.app`
- Latest verified deployment: `teetimeai-9x3rg84qh-derekpaulhoffmans-projects.vercel.app`
- Deployment ID: `dpl_4GBsjRDgyM1HKWi5xVpTBxbJaX1e`
- Vercel project ID: `prj_dI6LhLrDCSq06xgvtNvaKtF6Uz7Y`
- Vercel team/account ID: `team_qS5jqFYAovuxspGMzno0XtdK`

## Verified

- `npm run test:run`
- `npm run build`
- Production Vercel deploy completed successfully.
- `teetimespot.com` was purchased through Vercel, attached to the `teetimeai` project, and verified.
- `www.teetimespot.com` was attached to the same project and verified.
- Clerk production instance exists for `teetimespot.com`; DNS, SSL, and Clerk mail DNS are complete.
- Neon Postgres marketplace resource is connected, migrated, and seeded with the ForeUP demo adapter data.
- Live `/` returns 200 and renders the TeeTimeAI intake.
- Live `/dashboard` returns 200. Signed-out users see the account-management prompt instead of a missing sign-in route.
- Live `/api/courses/discover?latitude=41.242&longitude=-73.209&radiusMeters=30000` returns 200 with demo courses while Google Places is not configured.
- Live `POST /api/searches` accepts an alert email plus 1 to 5 ranked courses and creates an active search in Postgres.
- Live `/api/automation/active-searches` returns 200 with the configured `AUTOMATION_API_KEY`; latest smoke saw 5 active searches in the queue.
- Playwright browser smoke verified desktop course discovery, ranking, email-alert save, dashboard rendering, mobile layout, and zero browser console errors.
- Vercel runtime error scan found no errors after the cleaned-env deployment.

## Current Runtime Mode

The public site is live as an email-alert proof of concept:

- Nearby discovery falls back to demo course data until `GOOGLE_PLACES_API_KEY` is configured.
- Saved searches can still be stored in Neon by alert email for signed-out visitors.
- Clerk production keys are set in Vercel, but the app keeps Clerk disabled until `CLERK_AUTH_READY=true` because Google OAuth production credentials are still missing.
- Dashboard management actions require a signed-in Clerk account after Clerk auth is marked ready.
- Email sending is dry-run until Resend is configured.

## Remaining Provider Setup

- Clerk production: domain, DNS, SSL, mail DNS, and production keys are complete. Remaining blocker is Google OAuth production credentials. `clerk deploy status` reports `oauth_pending` for `google`; configure a Google OAuth client or disable Google OAuth in Clerk, then set `CLERK_AUTH_READY=true` in Vercel production and redeploy.
- Google Places/Geocoding: needs a Google Cloud project with Places API enabled, billing enabled, and `GOOGLE_PLACES_API_KEY` added to Vercel.
- Resend: needs an owned sending domain and API key, then add `RESEND_API_KEY` and `ALERT_EMAIL_FROM` to Vercel.
- Automation auth: `AUTOMATION_API_KEY` is set in production and local `.env.local`; keep it secret and rotate if exposed.

## Notes

- `npm run build` runs `prisma generate` before `next build` so clean Vercel builders have Prisma client types available.
- `.vercel/` and local env files are intentionally ignored. Do not commit provider credentials.
- The Codex loop remains alert-only and must not enter checkout, payment, verification-code, or account-specific booking flows.
