# Deployment Status

Last updated: 2026-07-08

## Live Vercel Deployment

- Project: `teetimeai`
- Production URL: `https://teetimeai.vercel.app`
- Latest verified deployment: `teetimeai-nko66b4hq-derekpaulhoffmans-projects.vercel.app`
- Vercel project ID: `prj_dI6LhLrDCSq06xgvtNvaKtF6Uz7Y`
- Vercel team/account ID: `team_qS5jqFYAovuxspGMzno0XtdK`

## Verified

- `npm run lint`
- `npm run test:run`
- `npm run build`
- Production Vercel deploy completed successfully.
- Live `/` returns 200 and renders the TeeTimeAI intake.
- Live `/dashboard` returns 200 and renders the setup-needed dashboard state.
- Live `/api/courses/discover?latitude=41.2429&longitude=-73.2007` returns 200 with seeded demo courses when Google Places is not configured.
- Chrome smoke verified:
  - Find courses loads demo courses.
  - Selecting a course ranks it as `#1`.
  - Save alert search becomes enabled after at least one course is selected.
  - Homepage and dashboard have no browser console errors in the smoke path.

## Current Runtime Mode

The site is deployed as a public proof-of-concept shell. It intentionally falls back to demo course discovery until the production provider keys are configured.

Full saved searches, real accounts, real nearby-course discovery, and email alerts still require these production environment variables and setup steps:

- Clerk: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, sign-in/sign-up URLs.
- Neon Postgres: `DATABASE_URL`, then run Prisma migrations.
- Google Places/Geocoding: `GOOGLE_PLACES_API_KEY`.
- Resend: `RESEND_API_KEY`, `RESEND_FROM_EMAIL`.
- Automation auth: `AUTOMATION_API_KEY`.

## Notes

- `npm run build` runs `prisma generate` before `next build` so clean Vercel builders have Prisma client types available.
- `.vercel/` and local env files are intentionally ignored. Do not commit provider credentials.
- The Codex loop remains alert-only and must not enter checkout, payment, verification-code, or account-specific booking flows.
