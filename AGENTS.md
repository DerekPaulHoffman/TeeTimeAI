# AGENTS.md

This file is the operating contract for Codex and other coding agents working in this repo.

## Repo Guardrails

- Work in the existing repo folder: `C:\dev\TeeTimeAI`.
- Do not create a new repository folder, clone directory, or linked worktree unless the user first gives explicit approval.
- Do not prefix new git branch names with `codex/` unless the user explicitly asks for that naming convention.
- Every Codex thread that may edit, commit, push, or deploy must use its own named task branch created from current `origin/main` before file edits. Never implement or commit directly on `main`.
- If the thread already owns a task branch, preserve it. Otherwise fetch `origin/main` and create a concise branch such as `fix/course-dedupe`, `feature/alert-controls`, or `chore/automation-policy`.
- Read-only threads and read-only automations must not create branches because they must not change git state.
- If unrelated work makes branch creation unsafe in the current checkout, do not switch, stash, or absorb it. Use an already-approved isolated worktree or ask for explicit worktree approval.
- Never revert user changes you did not make.
- Never run destructive commands such as `git reset --hard` or `git checkout --` without explicit user approval.
- Never commit secrets, `.env*` files, `.vercel/`, provider tokens, API keys, or copied credential values.
- Use `rg` or `rg --files` first for search.
- Use `apply_patch` for manual file edits.
- Keep the repo as a Next.js/TypeScript/Postgres app. The legacy Python crawler is reference-only.

## Product Contract

Tee Time Spot is an alert-only tee-time waitlist assistant for public golf courses.

The app should:

- Discover nearby likely-public golf courses.
- Let users rank 1 to 5 preferred courses.
- Capture a future date, time window, player count, the signed-in account email as the primary alert email, and optional extra recipients.
- Store real demand in Postgres.
- Let the automation find matching public tee times.
- Email official booking links.
- Let users manage active searches from the dashboard.
- Capture feedback and basic engagement signals.

The app must not:

- Book tee times for users.
- Hold, reserve, or pay for tee times.
- Enter checkout.
- Use verification-code flows.
- Bypass captchas, queues, rate limits, or access controls.
- Use account-specific course sessions in the POC.
- Automate retrieval when a course blocks or prohibits automation.
- Imply that Tee Time Spot completes the booking.

Use copy such as "official site", "official booking page", "direct link", and "you book direct". Avoid copy such as "we book", "Tee Time Spot books", or anything implying guaranteed availability.

## Canonical Decisions

- Canonical product name: `Tee Time Spot`.
- Canonical domain: `teetimespot.com`.
- The repo folder and GitHub repo can still be named `TeeTimeAI`.
- V1 notification channel: email only.
- No SMS until email demand is proven.
- No payments or marketplace checkout in the POC.
- Clerk is the account system, but `CLERK_AUTH_READY` gates production account mode.
- Signed-out visitors may browse courses, but creating, changing, pausing, or stopping alerts requires a Clerk account.
- Google Places is used for course discovery and photos.
- Course discovery defaults to a 15-mile radius and offers 5 to 30 mile choices.
- Discovery should prefer public golf courses and filter stores, simulators, private clubs, and likely non-course results.
- Extra recipients are part of the product: do not remove `TeeSearch.additionalEmails` or dashboard recipient UI.
- Feedback is part of the product-learning loop: do not remove `WebsiteEvent`, `WebsiteFeedback`, or the feedback widget.
- The automation should improve the product over time using evidence, not just rerun the same prompt.

## Architecture

Core app:

- Next.js 16 App Router.
- React 19.
- TypeScript.
- Prisma 7.
- Neon Postgres.
- Vercel hosting.
- Resend email.
- Clerk auth.
- Google Places.

Core folders:

- `src/app`: routes, pages, route handlers, metadata routes.
- `src/components`: client UI components.
- `src/lib`: domain logic, integrations, validation, automation helpers.
- `scripts/automation`: local Codex automation entrypoints.
- `scripts/seed-foreup.ts`: known ForeUP adapter seed data.
- `prisma/schema.prisma`: database schema.
- `tests/ui`: Playwright smoke tests.
- `docs`: operational and product documentation.
- `legacy/python-crawler`: old prototype, not active app code.

Core data:

- `User`: Clerk account owner; legacy guest-style rows may remain only for sign-in migration.
- `Course`: discovered/supported course plus automation metadata.
- `TeeSearch`: saved demand.
- `CoursePreference`: ranked course list.
- `CourseProbe`: per-course automation observation.
- `TeeTimeMatch`: normalized matching slot.
- `AutomationRun`: durable poll/improvement run record.
- `WebsiteEvent`: engagement event.
- `WebsiteFeedback`: user feedback.

## Environment And Secrets

Expected env names:

- `DATABASE_URL`
- `DATABASE_URL_UNPOOLED`
- `GOOGLE_PLACES_API_KEY`
- `RESEND_API_KEY`
- `RESEND_EMAIL_DOMAIN`
- `ALERT_EMAIL_FROM`
- `AUTOMATION_API_KEY`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_AUTH_READY`
- `NEXT_PUBLIC_SITE_URL`

Rules:

- Never print secret values in final answers.
- Never commit secret values.
- Redact keys in docs and `AutomationRun.notes`.
- Normalize copied env values when code reads provider keys because copied values have previously included BOM/whitespace.
- Prefer provider dashboards, Vercel env vars, or ignored local env files for credentials.
- If a setup action needs billing, payment methods, ownership transfer, legal acceptance, or domain purchase, get fresh explicit approval.

## Google Places Rules

Current nearby search:

- Uses Places API (New) `places:searchNearby`.
- Sends `includedTypes: ["golf_course"]`.
- Requests only needed fields.
- Uses `places:searchText` style geocoding for typed location fallback.
- Uses `/api/courses/photo` as a proxy/redirect for transient Places photo references.

Filtering expectations:

- Require `primaryType` to be `golf_course`.
- Require `types` to include `golf_course`.
- Exclude non-operational places.
- Exclude known non-course primary types such as stores, indoor/simulator surfaces, sports clubs, and associations.
- Exclude known private/non-course name patterns.
- When the user reports a bad result, add focused tests around the real shape rather than broad string hacks.

Do not over-request fields. Keep field masks tight.

## Automation Loop Contract

There are two related but different automation workflows.

### Event-Driven Search Checks

Production search checks are owned by a durable per-search Vercel Workflow. Creating, editing, resuming, or explicitly checking an active search starts a workflow immediately. After each check it sleeps until that search's next useful check time, then starts the next run on the latest deployment.

Preferred commands:

```powershell
npx vercel env run -- npm run automation:poll
npx vercel env run -- npm run automation:inspect
```

Important behavior:

- `automation:poll` is a manual recovery command, not a recurring 15-minute production scheduler.
- A daily recovery cron performs only a lightweight database query for overdue/stuck schedules and starts work only when needed.
- `TeeSearch.checkStatus`, `nextCheckAt`, `lastCheckedAt`, `lastCheckOutcome`, and `workflowRunId` describe scheduler state.
- `TeeTimeMatch.availabilityStatus` is independent from email `alertStatus`; emailed matches remain visible while they are still confirmed available.
- The truth is in Postgres: `AutomationRun`, `CourseProbe`, `TeeTimeMatch`, and pending alerts.
- Use `automation:inspect` to classify the result.
- Report normalized outcomes such as `success`, `no new matches`, `alerts sent/dry-run`, `blocked_env`, `needs_adapter`, or `blocked_policy`.
- Do not revive the retired 15-minute Codex poller.

The historical automation memory path for manual recovery runs is:

```text
C:\Users\Grim_Leaper\.codex\automations\teetimeai-active-search-poller\memory.md
```

### Hourly Improvement Loop

The hourly improvement loop is allowed to improve the product when evidence supports a change.

It should:

- Run or inspect queue state.
- Run UI smoke.
- Identify the highest-leverage blocker or improvement.
- Use current tool/design research when UI/tooling is weak.
- Implement one coherent improvement.
- Verify with tests, lint, build, and browser smoke.
- Record outcome, changed files, and blockers.

Required checkpoints:

- `queue_confirmed`
- `candidate_selected`
- `tool_research_done`
- `ui_smoke_done`
- `verification_done`
- `outcome_recorded`

Do not mark a checkpoint true unless it happened.

## Course Automation Rules

Before fetching a tee sheet:

- Check `Course.automationEligibility`.
- Check `Course.policyNotes`.
- Evaluate policy text if available.
- Skip `BLOCKED` courses.
- Record `BLOCKED_POLICY` if terms appear to prohibit automated retrieval.
- Record `NEEDS_ADAPTER` for unsupported platforms.
- Record `NO_MATCH` for supported checks with no qualifying time.
- Record `MATCH_FOUND` when a slot qualifies.

Adapter behavior:

- Use public tee-sheet endpoints only.
- Prefer stable source IDs to dedupe matches.
- Do not alert duplicate matches.
- Do not suppress successful probes for one course because another course failed.
- Keep per-course evidence and failure notes.
- Use transaction-scoped Postgres advisory leases for poller mutation; session-level locks are risky with pooled Neon connections.

## ForeUP Decisions

ForeUP is the first supported adapter class.

Known seeded/support course examples include:

- Tashua Knolls.
- H. Smith Richardson.
- Oak Hills Park Golf Course.

Known historical context:

- Tashua Knolls and H. Smith Richardson came from an earlier public ForeUP monitor.
- Some ForeUP public tee sheets require booking class metadata.
- Some ForeUP public tee sheets do not.
- The adapter must stay alert-only and avoid checkout/account flows.

If adding a ForeUP course:

- Confirm it is the official public booking surface.
- Store detected booking URL/platform/metadata on `Course`.
- Set automation eligibility only when retrieval is allowed.
- Add or update focused tests.
- Run `automation:inspect` after poll verification.

## Figma And Design Workflow

When the user provides a Figma or Figma Make URL, use the Figma MCP/plugin first.

For normal Figma design files:

- Fetch design context for the exact node.
- Fetch screenshot when supported.
- Download/use returned assets.
- Translate to the repo's Next.js/CSS conventions.
- Verify with browser screenshots.

For Figma Make files:

- Use `get_design_context` with `nodeId: "0:1"`.
- Normal `get_metadata` and `get_screenshot` are not supported for `/make/` files.
- The MCP response usually returns `file://figma/make/source/...` source-tree links and `file://figma/make/image/...` asset links.
- Start by reading `src/app/App.tsx`, then read only the imported screen/component files relevant to the requested surface.
- For dashboard work, look for generated screen imports such as `src/imports/*Desktop*`, `src/imports/*Dashboard*`, `src/styles/theme.css`, `src/styles/globals.css`, `src/styles/tailwind.css`, and `default_shadcn_theme.css`.
- Treat the Figma Make source as the design source of truth for layout, spacing, colors, typography, component composition, and asset references.
- Treat the Figma Make source as reference code, not as app architecture. Port the visual structure into this repo's Next.js routes/components while preserving live data, auth, database models, product safety copy, and tests.
- If resource links cannot be dereferenced, use the Make preview in the browser for visual validation.
- Do not blindly paste generated Vite/shadcn output into the app. Figma Make often generates a standalone Vite/static/shadcn app with mock data and different folder conventions.
- When implementing from Make, map mock lists/cards/actions to real `TeeSearch`, `CoursePreference`, `TeeTimeMatch`, `CourseProbe`, and dashboard actions.
- Download or reuse Make assets only when they are part of the visual design; do not replace functional icons/components with static screenshots.
- Validate the implementation by running the local app and comparing browser screenshots against the Make preview or generated design reference.

Current design additions that must survive redesigns:

- Extra alert emails on searches/dashboard.
- Feedback widget and API.
- Email preview route.
- Alert-only safety copy.
- Public course filtering.
- Dashboard search management.

## UI Standards

The UI should be polished, mobile-first, and action-focused.

Important checks:

- No horizontal overflow.
- No tiny clickable targets.
- No clipped button text.
- No visible implementation jargon in public user flows.
- Course ranking limit must be obvious.
- Dashboard must clearly show active/paused/completed state.
- Email preview must be accessible.
- Feedback widget must not block core flows.
- Mobile header must not wrap awkwardly.
- Hero should keep `Tee Time Spot` as the first-viewport brand signal.

When screenshots look weak, do not keep minor-polishing a bad direction. Use Figma/Figma Make, v0, or another current design tool, then bring the best ideas back into this repo with verification.

## Testing And Verification

Before claiming code/UI work is complete:

```powershell
npm run test:run
npm run lint
npm run build
npm run ui:smoke
git diff --check
```

For production verification:

```powershell
$env:UI_SMOKE_BASE_URL = "https://teetimespot.com"
npm run ui:smoke
Remove-Item Env:\UI_SMOKE_BASE_URL
```

For quick HTTP checks:

```powershell
Invoke-WebRequest -Uri "https://teetimespot.com/" -UseBasicParsing
Invoke-WebRequest -Uri "https://teetimespot.com/dashboard" -UseBasicParsing
Invoke-WebRequest -Uri "https://teetimespot.com/email-preview" -UseBasicParsing
```

Playwright smoke expectations:

- Desktop and mobile coverage.
- Onboarding discovery works.
- Course ranking 1 to 5 is enforced.
- Date must be future.
- End time must be after start time.
- Players options are 1 to 4.
- Dashboard access/setup state is clear.
- Email preview renders expected alert content.
- No same-origin failed requests.
- No browser console/page errors.
- No horizontal overflow.
- Interactive elements are usable.

## Deployment Rules

Production deploy command:

```powershell
npx vercel --prod --yes
```

After deploy:

- Verify Vercel reports `Ready`.
- Verify aliases include `teetimespot.com` and `www.teetimespot.com`.
- Smoke production with `UI_SMOKE_BASE_URL`.
- Check main routes return 200.
- Check Vercel error logs.
- Update `docs/deployment-status.md` when provider/deploy state changes.

Use Vercel CLI guidance for current command behavior. The CLI version can change.

## Documentation Rules

Keep docs source-backed:

- README is the project handbook.
- AGENTS.md is the agent operating contract.
- `docs/codex-automation-loop.md` is the detailed loop contract.
- `docs/deployment-status.md` is the provider/deployment status log.
- `docs/ux-research-notes.md` is design/product research guidance.

Update docs when decisions change. Do not let old TeeTimeAI branding creep back into user-facing docs except when referring to repo/provider names.

## Git And PR Behavior

- Keep commits coherent.
- Include tests/docs with behavior changes.
- Do not stage unrelated user work without understanding it.
- Run `git status --short` before and after commits.
- Commit on the thread-owned task branch, never on `main`.
- Before publishing, fetch `origin/main`, rebase the clean task branch when needed, and rerun affected verification.
- When the user authorizes a direct push or production release, fast-forward `main` from the verified task branch with `git push origin HEAD:main`. Do not check out or commit on local `main`, and never force-push `main`.
- Push the task branch itself only when a PR, review branch, or remote backup is useful or requested.
- After pushing to `main`, require `git rev-list --left-right --count HEAD...origin/main` to report `0 0` before deployment or completion.
- Push only when the user has asked for or clearly authorized end-to-end implementation/deploy work.

## Current Known Gaps

Provider/setup gaps can drift, so verify before acting. Last known items:

- Clerk account mode is gated until production auth is fully ready.
- Google OAuth for Clerk was the last known auth blocker.
- Google Places key should remain restricted and should be rotated after confirming healthy production behavior.
- Adapter coverage is intentionally narrow; add adapters only with policy-safe public retrieval evidence.
- Admin/reporting for feedback, events, probes, and adapter gaps can be improved.

## Useful Commands

```powershell
npm install
npx vercel env pull .env.local --yes
npm run prisma:generate
npm run dev
npm run prisma:migrate
npm run seed:foreup
npm run test:run
npm run lint
npm run build
npm run ui:smoke
npm run automation:poll
npm run automation:inspect
npm run automation:improve
npx vercel --prod --yes
```

Use `npx vercel env run -- <command>` when a local automation command needs provider env vars.
