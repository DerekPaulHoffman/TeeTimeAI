# Deployment Status

Last updated: 2026-07-08

## Live Vercel Deployment

- Project: `teetimeai`
- Production URL: `https://teetimeai.vercel.app`
- Latest verified deployment: `teetimeai-bg3xjer75-derekpaulhoffmans-projects.vercel.app`
- Deployment ID: `dpl_YRNwN7FvBp9dGVpUnAHzXPvWxT7y`
- Vercel project ID: `prj_dI6LhLrDCSq06xgvtNvaKtF6Uz7Y`
- Vercel team/account ID: `team_qS5jqFYAovuxspGMzno0XtdK`

## Verified

- `npm run test:run`
- `npm run build`
- Production Vercel deploy completed successfully.
- Neon Postgres marketplace resource is connected, migrated, and seeded with the ForeUP demo adapter data.
- Live `/` returns 200 and renders the TeeTimeAI intake.
- Live `/dashboard` returns 200 and renders the database-backed email-alert POC dashboard.
- Live `/api/courses/discover?latitude=41.242&longitude=-73.209&radiusMeters=30000` returns 200 with demo courses while Google Places is not configured.
- Live `POST /api/searches` accepts an alert email plus 1 to 5 ranked courses and creates an active search in Postgres.
- Live `/api/automation/active-searches` returns 200 with the configured `AUTOMATION_API_KEY`; latest smoke saw 3 active searches and the browser-created smoke search in the queue.
- Playwright browser smoke verified desktop course discovery, ranking, email-alert save, dashboard rendering, mobile layout, and zero browser console errors.
- Vercel runtime error scan found no errors after the cleaned-env deployment.

## Current Runtime Mode

The public site is live as an email-alert proof of concept:

- Nearby discovery falls back to demo course data until `GOOGLE_PLACES_API_KEY` is configured.
- Saved searches are stored in Neon by alert email until Clerk production accounts are connected.
- Dashboard management actions are read-only in POC mode; pause/resume/cancel unlock when Clerk production is available.
- Email sending is dry-run until Resend is configured.

## Remaining Provider Setup

- Clerk production: blocked by provider requirement for an owned domain and DNS access. `clerk deploy` rejected `teetimeai.vercel.app` as a provider domain. After an owned domain is connected, run `clerk deploy`, then set production `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`.
- Google Places/Geocoding: needs a Google Cloud project with Places API enabled, billing enabled, and `GOOGLE_PLACES_API_KEY` added to Vercel.
- Resend: needs an owned sending domain and API key, then add `RESEND_API_KEY` and `ALERT_EMAIL_FROM` to Vercel.
- Automation auth: `AUTOMATION_API_KEY` is set in production and local `.env.local`; keep it secret and rotate if exposed.

## Notes

- `npm run build` runs `prisma generate` before `next build` so clean Vercel builders have Prisma client types available.
- `.vercel/` and local env files are intentionally ignored. Do not commit provider credentials.
- The Codex loop remains alert-only and must not enter checkout, payment, verification-code, or account-specific booking flows.
