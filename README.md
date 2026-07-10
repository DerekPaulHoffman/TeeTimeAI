# Tee Time Spot

Tee Time Spot is an alert-only tee-time waitlist assistant for public golf courses.

The product helps a golfer answer one practical question: "Where can I play, at the courses I actually like, in the window I am free?" A user enters a location and search distance (15 miles by default), picks nearby public courses, ranks 1 to 5 favorites, chooses a future date, time window, player count, and alert recipients, then receives an email when a matching tee time appears. The user finishes booking directly on the official course website.

Tee Time Spot does not book, hold, reserve, pay for, bypass controls, or enter account-specific checkout flows.

## Current State

- Product name: `Tee Time Spot`
- Domain: `https://teetimespot.com`
- Vercel project: `teetimeai`
- Latest verified production deployment: `dpl_AhXpEZKxiNfsBffmfc5bR33kHKkX`
- Production aliases: `https://teetimespot.com`, `https://www.teetimespot.com`, `https://teetimeai.vercel.app`
- App runtime: Next.js on Vercel with Neon Postgres
- Worker runtime: local or scheduled Codex automation using repo scripts and Postgres state
- POC notification channel: email only
- Initial supported booking platform: ForeUP public tee sheets
- Initial known adapters/data: Tashua Knolls, H. Smith Richardson, and Oak Hills style ForeUP metadata

## Product Decision Log

These decisions are the current contract for future work.

### Waitlist Assistant, Not Marketplace

Tee Time Spot is not trying to become GolfNow or a full booking marketplace in v1. The UX should be closer to a waitlist assistant:

- Capture intent once.
- Watch ranked courses.
- Alert only when a matching slot opens.
- Send the golfer to the official course booking page.

Marketplace browsing, deal merchandising, broad inventory search, checkout, loyalty, and payments are intentionally out of scope for the proof of concept.

### Alert Only

The product must always be clear that Tee Time Spot finds openings and sends links. It does not complete tee times for the user.

Allowed:

- Read public tee-sheet availability when policy allows it.
- Normalize available slots into `TeeTimeMatch`.
- Send email alerts with official booking links.
- Let users pause, resume, edit, or remove saved searches.

Not allowed:

- Enter checkout.
- Pay.
- Hold or reserve tee times.
- Create course-specific user accounts for booking.
- Use verification codes.
- Bypass captchas, queues, rate limits, or access controls.
- Automate a course that blocks automated retrieval.

### Public Course Discovery

Course discovery starts with Google Places Nearby Search constrained to the `golf_course` primary-type family. A separate IDs-only Text Search for `public golf courses` supplies positive evidence for ambiguous club-style listings without increasing the main result payload.

The app currently filters likely non-public or non-course results because Google Places can include stores, simulators, and private clubs in the broader golf surface. Current filters require:

- `primaryType === "golf_course"`
- `types` includes `golf_course`
- `businessStatus` is absent or `OPERATIONAL`
- Excludes non-course primary types and secondary indoor-course signals
- Excludes generic ancillary surfaces such as club fitting, pro shops, general stores, clubhouses, driving ranges, simulators, and junior or disc-golf clubs
- Rejects explicit private/member names and ambiguous membership-club listings unless Google also returns them for the semantic public-course query
- Collapses separate Place IDs that normalize to the same course identity at the same address or within the same venue, while preserving distinct co-located courses

This is intentionally conservative. False positives, such as stores or private clubs, should be filtered before they reach the ranking UX. False negatives should be fixed carefully with evidence from the real Places result and the official course website.

### One Group, Not an Outing

Searches are capped to `1` through `4` players. This keeps the POC focused on a normal tee-time group and avoids implying large-group or event handling.

### Ranked Course Preferences

Users must select at least 1 course and can select up to 5 courses. Ranking matters:

- Rank 1 is the user's favorite.
- The automation should prefer higher-ranked courses when presenting/alerting equivalent matches.
- Course preferences are durable data, not temporary UI state.

### Extra Alert Emails

Each search can include up to `3` additional alert recipients. This supports sending alerts to playing partners without adding SMS or account complexity in v1.

Implementation notes:

- Stored on `TeeSearch.additionalEmails`.
- Normalized to lowercase and deduped.
- Editable from the dashboard.
- Rendered in dashboard cards as an email stat.

### Feedback Flow

The site includes a feedback widget and API because the POC is explicitly about proving whether people will use the product.

The Tee Time Spot Discord at `https://discord.gg/ThexF85xCd` is the public community for longer-form feedback and product suggestions. The site links to it from the global navigation, feedback panel, and footer.

Feedback events are stored in Postgres:

- `WebsiteEvent` for page/interaction events.
- `WebsiteFeedback` for like/dislike/broken feedback, optional details, page, and contact email.

Feedback capture is product data, not cosmetic UI. Do not remove it during design work.

### Branding

Canonical user-facing name: `Tee Time Spot`.

The old project/repo name `TeeTimeAI` still appears in physical paths, GitHub URLs, and some provider project names. User-facing UI, metadata, copy, package name, and docs should use Tee Time Spot unless referring to the historical repo name.

The purchased domain intentionally does not include `ai`.

### Design Direction

The current UI was redesigned from a Figma Make direction. Important visual decisions:

- Image-led, full-bleed golf hero.
- Dark glass navigation.
- Large `Tee Time Spot` first-viewport brand signal.
- Action-focused onboarding, not a marketing landing page.
- Map/list style course discovery with photos when Places returns them.
- Dashboard focused on active alerts, ranked courses, status, matches, and controls.
- Email preview that shows the actual alert email and direct official booking link.
- Feedback widget remains available across the app.

Figma Make links are not normal Figma design files. The Figma MCP supports `get_design_context` for `/make/` URLs with node `0:1`, but normal `get_metadata` and `get_screenshot` are not supported for Figma Make files. Use the MCP output for source/assets and browser screenshots of the Figma Make preview for visual parity.

## Tech Stack

- Next.js 16 App Router
- React 19
- TypeScript
- Prisma 7
- Neon Postgres
- Clerk accounts, gated by `CLERK_AUTH_READY`
- Resend email
- Google Places API (New)
- Playwright browser smoke tests
- Vitest unit/integration tests
- Vercel hosting, domains, and environment management
- Local/scheduled Codex automation scripts

## High-Level Architecture

```text
User browser
  -> Next.js app
    -> Google Places discovery and photo proxy
    -> Search validation with Zod
    -> Prisma/Neon persisted searches
    -> Dashboard management and feedback APIs

Codex automation
  -> Reads active TeeSearch rows
  -> Checks Course automation eligibility and policy notes
  -> Runs known course/platform adapters
  -> Records CourseProbe outcomes
  -> Upserts TeeTimeMatch rows
  -> Sends Resend alerts for new pending matches
  -> Marks alerts sent/suppressed idempotently
```

## Data Model

Core models:

- `User`: Clerk user reference or guest-style alert-email user record.
- `Course`: Google place id, name, address, coordinates, phone, website, photo, public/manual flags, detected booking URL/platform, automation eligibility, policy notes, and booking metadata.
- `TeeSearch`: user, date, start/end time, players, cadence, status, and additional alert emails.
- `CoursePreference`: ranked join from a search to selected courses.
- `CourseProbe`: per-course automation observation, outcome, message, evidence, raw summary, and optional automation run.
- `TeeTimeMatch`: normalized available slot evidence, available spots, optional price/holes, booking URL, first/last seen, and alert status.
- `AutomationRun`: durable record for poll/improvement runs, prompt version, outcome, errors, changed files, and notes.
- `WebsiteEvent`: product analytics events.
- `WebsiteFeedback`: feedback submissions.

Important enums:

- `SearchStatus`: `ACTIVE`, `PAUSED`, `COMPLETED`, `CANCELLED`
- `AutomationEligibility`: `UNKNOWN`, `ALLOWED`, `BLOCKED`, `NEEDS_REVIEW`
- `DetectedPlatform`: `UNKNOWN`, `FOREUP`, `GOLFNOW`, `TEEITUP`, `CHRONOGOLF`, `CLUB_CADDIE`, `CUSTOM`
- `ProbeOutcome`: `MATCH_FOUND`, `NO_MATCH`, `BLOCKED_POLICY`, `BLOCKED_AUTH`, `BLOCKED_TOOLING`, `FETCH_FAILED`, `NEEDS_ADAPTER`
- `AlertStatus`: `PENDING`, `SENT`, `SUPPRESSED`
- `FeedbackSentiment`: `LIKE`, `DISLIKE`, `BROKEN`

## Application Surfaces

### Home And Intake

The homepage lets users:

- Understand Tee Time Spot immediately.
- Use browser geolocation or typed city/ZIP fallback.
- Discover nearby likely-public golf courses.
- See course photos, addresses, ratings, and official site links when available.
- Select and rank 1 to 5 courses.
- Choose future date, start/end time, and 1 to 4 players.
- Add alert email and optional extra recipients.
- Save a search.

The intake should not expose implementation terms like `Codex`, `Postgres`, `Clerk`, `Neon`, `adapter`, or `Google Places` in normal user-facing copy.

### Dashboard

The dashboard shows:

- Active alert count.
- Courses watched.
- Matches found.
- Saved searches.
- Search status.
- Date/time/player details.
- Course ranking and official links.
- Extra recipient count.
- Edit/pause/resume/remove controls when management is available.
- Recent pending matches.

With Clerk disabled, the POC can still show/manage recent searches using the database-backed email mode. Once production auth is fully ready, dashboard management should be tied to Clerk accounts.

### Email Preview

`/email-preview` renders the same alert HTML used by Resend, with fixed sample data and no email side effects.

The email must:

- Look like a Tee Time Spot alert.
- Show course, time, date, player count, and direct booking link.
- Use the Figma-style CTA `Book this tee time`.
- Explain that the link goes to the course's own booking page.
- Avoid implying Tee Time Spot books for the user.
- State availability is first come, first served.

### Feedback Widget

The feedback widget appears globally and lets users report:

- Like
- Dislike
- Broken
- Details
- Optional contact email

It posts to `/api/feedback`. Page/interaction events post to `/api/analytics/events`.

## API Surfaces

Public/product APIs:

- `GET /api/location/geocode`
- `GET /api/courses/discover`
- `GET /api/courses/photo`
- `POST /api/searches`
- `GET /api/searches`
- `PATCH /api/searches/[id]`
- `DELETE /api/searches/[id]`
- `POST /api/feedback`
- `POST /api/analytics/events`

Automation APIs:

- `GET /api/automation/active-searches`
- `POST /api/automation/probes`
- `POST /api/automation/matches`
- `POST /api/automation/alerts/[id]/sent`

Automation APIs require `AUTOMATION_API_KEY`.

## Environment Variables

Required for saved searches:

- `DATABASE_URL`

Useful for Neon/Prisma operations:

- `DATABASE_URL_UNPOOLED`

Required for live Google Places discovery:

- `GOOGLE_PLACES_API_KEY`

Required for the interactive course map:

- `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY`
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`

The browser key must have Google Maps JavaScript API enabled. Restrict it by HTTP
referrer for the deployed domains after verifying the map loads.

Required for live email sending:

- `RESEND_API_KEY`
- `ALERT_EMAIL_FROM`
- `RESEND_EMAIL_DOMAIN`

Required for automation endpoints/scripts:

- `AUTOMATION_API_KEY`

Required for Clerk account mode:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_AUTH_READY=true`

Site metadata:

- `NEXT_PUBLIC_SITE_URL`

Never commit secret values. Local env files and `.vercel/` are intentionally ignored.

## Local Setup

```powershell
npm install
npx vercel env pull .env.local --yes
npm run prisma:generate
npm run dev
```

Open:

```text
http://127.0.0.1:3000
```

The homepage can preview with demo course data before Google Places is configured. Saving searches requires a migrated database.

## Database Setup

For local schema work:

```powershell
npm run prisma:migrate
npm run seed:foreup
```

For production-style migration deploys, prefer the unpooled Neon URL and Prisma migrate deploy. On Windows, if `.env.local` is not automatically loaded by a command, explicitly set `DATABASE_URL` from `DATABASE_URL_UNPOOLED` before migration.

The seed script adds known ForeUP adapter metadata for the first supported public tee sheets.

## Automation

Main commands:

```powershell
npm run automation:poll
npm run automation:inspect
npm run automation:improve
npm run automation:configure-known-foreup
```

In this workspace, the reliable environment-loaded command shape is:

```powershell
npx vercel env run -- npm run automation:poll
npx vercel env run -- npm run automation:inspect
```

`automation:poll`:

- Is a manual recovery command for due active searches, not the production scheduler.
- Uses the same per-search checker as the durable workflow.
- Acquires a per-search Postgres transaction-scoped advisory lease.
- Records probes.
- Reconciles currently available and gone matches.
- Sends or dry-runs alerts.
- Marks alerts sent/suppressed.

Creating, editing, resuming, or manually checking a search starts its durable workflow. Each run checks only that search, updates Postgres before sending email, calculates `nextCheckAt`, sleeps without active compute, and chains the next run onto the latest deployment. A daily recovery cron only restarts overdue or failed schedules.

`automation:inspect` is the preferred truth source for classifying checks. The authoritative state is stored in `TeeSearch` scheduler fields, `AutomationRun`, `CourseProbe`, `TeeTimeMatch`, and pending alerts.

`automation:improve` records a Codex-ready improvement prompt. The hourly loop should inspect recent failures, UI smoke results, and product friction, then ship the highest-leverage safe improvement.

See `docs/codex-automation-loop.md` for the full run contract.

## Automation Outcomes

Use normalized outcomes when reporting runs:

- `success`
- `no new matches`
- `alerts sent/dry-run`
- `no_op`
- `needs_adapter`
- `blocked_policy`
- `blocked_auth`
- `blocked_tooling`
- `blocked_env`
- `needs_human`

Common probe meaning:

- `NO_MATCH`: checked successfully, no qualifying time found.
- `MATCH_FOUND`: qualifying time found and recorded.
- `NEEDS_ADAPTER`: course/platform is not supported yet.
- `BLOCKED_POLICY`: terms or stored eligibility prohibit automation.
- `BLOCKED_AUTH`: access requires auth, captcha, verification, or a restricted account.
- `FETCH_FAILED`: network/provider failure.

## Verification

Before considering a code or UI change complete:

```powershell
npm run test:run
npm run lint
npm run build
npm run ui:smoke
```

For production smoke:

```powershell
$env:UI_SMOKE_BASE_URL = "https://teetimespot.com"
npm run ui:smoke
Remove-Item Env:\UI_SMOKE_BASE_URL
```

The Playwright smoke covers:

- Desktop and mobile onboarding.
- Typed-location discovery.
- Course ranking limit enforcement.
- Save validation and duplicate-submission prevention.
- Dashboard access/setup states.
- Email preview accessibility.
- Browser console/page errors.
- Same-origin failed requests.
- Horizontal overflow.
- Undersized interactive controls.

## Deployment

Production deploy:

```powershell
npx vercel --prod --yes
```

Post-deploy checks:

```powershell
Invoke-WebRequest -Uri "https://teetimespot.com/" -UseBasicParsing
Invoke-WebRequest -Uri "https://teetimespot.com/dashboard" -UseBasicParsing
Invoke-WebRequest -Uri "https://teetimespot.com/email-preview" -UseBasicParsing
$env:UI_SMOKE_BASE_URL = "https://teetimespot.com"
npm run ui:smoke
Remove-Item Env:\UI_SMOKE_BASE_URL
npx vercel inspect <deployment-url>
npx vercel logs <deployment-url> --since 30m --level error
```

Keep `docs/deployment-status.md` current after provider, deployment, auth, domain, or migration changes.

## Known Provider State

- Vercel project and domain are live.
- Neon Postgres is connected and migrated.
- Google Places API is configured for discovery and photos.
- Resend is configured for email sending.
- Clerk production instance exists, but app account mode is gated behind `CLERK_AUTH_READY=true`.
- Google OAuth production setup for Clerk was the last known auth blocker.
- The Google Places key was shared during setup; keep it API-restricted and rotate after confirming production remains healthy.

Provider state can drift. Verify with current provider dashboards/CLI before making claims.

## Legacy Code

The original Python crawler prototype is preserved under:

```text
legacy/python-crawler
```

Treat it as reference material only. The active application is the TypeScript/Next.js app in this repo root.

## Documentation Map

- `README.md`: product and engineering handbook.
- `AGENTS.md`: operating instructions for Codex/agent work.
- `docs/codex-automation-loop.md`: loop engineering contract.
- `docs/deployment-status.md`: provider and deploy status log.
- `docs/ux-research-notes.md`: UX principles and design-tool guidance.

## Future Work

Highest-leverage next areas:

- Finish Clerk production auth by resolving the Google OAuth blocker or disabling Google OAuth.
- Continue expanding course adapters only when policy allows public availability retrieval.
- Improve public/private course classification with more evidence-backed rules.
- Add better admin visibility for feedback, events, probes, matches, and adapter gaps.
- Add stronger user notification preferences after proving email demand.
- Keep using Figma/Figma Make or another current design workflow when browser screenshots show UI quality issues.
