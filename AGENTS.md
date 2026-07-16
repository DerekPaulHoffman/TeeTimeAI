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
- Bypass active captchas, waiting rooms/queues, rate limits, authentication, or other technical access controls.
- Use account-specific course sessions in the POC.
- Imply that Tee Time Spot completes the booking.

Use copy such as "official site", "official booking page", "direct link", and "you book direct". Avoid copy such as "we book", "Tee Time Spot books", or anything implying guaranteed availability.

Booking, reservation, purchase, and checkout policies govern those transactions; they do not govern observation of public availability. Public, signed-out, read-only tee-time data is eligible for monitoring regardless of provider or course terms about booking automation. Policy text alone must never set `BLOCKED` or `BLOCKED_POLICY`, overwrite a working official booking link, or stop adapter investigation. Terms may be retained as evidence, but current observed public access is the source of truth for monitoring eligibility. The technical boundary remains strict: do not solve, generate, replay, or bypass captcha tokens; do not bypass waiting rooms, rate limits, authentication, or access controls; do not use private/account-specific data; and do not proceed into booking or checkout.

## Product Mental Model

The product is a saved-demand and notification system, not a live tee-time marketplace. A golfer tells Tee Time Spot where and when they want to play; the app persists that intent, monitors public read-only booking surfaces without entering the transaction flow, and sends the golfer back to the course to finish the booking.

There are five important actors:

- **Visitor:** can search locations, discover public courses, inspect official links, and rank courses without signing in.
- **Alert owner:** a signed-in golfer whose Clerk account owns saved searches, dashboard controls, and the primary alert email.
- **Additional recipient:** receives the same search emails but does not own the dashboard search merely because their email is listed. Anyone holding a valid signed stop link from an alert email can still complete/cancel that alert without Clerk, so treat those links as bounded bearer credentials.
- **Course/provider:** owns the official course identity, booking policy, booking window, tee sheet, and final booking transaction.
- **Operator/engineering loop:** reviews evidence, fixes provider coverage, resolves durable incidents, and improves the product; it does not impersonate the golfer or enter checkout.

Keep the value proposition legible in every change:

```text
discover public courses -> save ranked demand -> check official availability
-> email matching openings -> golfer books on the official site
```

## Customer Journeys

### 1. Browse And Build A Shortlist

1. A visitor opens `/` or `/search`, uses browser location or enters a city/ZIP, and chooses a 5-to-30-mile radius; 15 miles is the default.
2. The app geocodes the location, discovers likely-public courses, applies exact reviewed exceptions plus generic safety filters, deduplicates provider aliases, and enriches results with available photos and recent price evidence.
3. The visitor may filter for a verified physical 9-hole or 18-hole course layout. Physical layout is independent from whether a provider sells a 9-hole or 18-hole round.
4. The visitor selects and ranks 1 to 5 courses. Rank and selection must remain stable while browsing; selecting a course must not unexpectedly reshuffle the discovery list.
5. If a course is missing, the visitor can search by course name and town. A zero-result direct lookup is a recovery signal, not proof that the course does not exist; persist a `[COURSE_LOOKUP_MISS]` feedback record with bounded context for investigation.

### 2. Create An Alert

1. The golfer chooses a future date, start/end window, 1 to 4 players, and an optional verified course-layout preference.
2. Signed-out golfers are asked to sign in. The server derives the owner and primary email from Clerk; never trust a client-supplied owner ID or primary email. The owner may later add up to 3 normalized additional recipients from the dashboard.
3. A user may have at most 3 `ACTIVE` plus `PAUSED` searches. Search creation resolves selected provider candidates into reusable `Course` rows, persists `TeeSearch` plus ranked `CoursePreference` rows, and then requests that search's durable workflow immediately.
4. Persisted demand and scheduler launch are separate facts: the API can keep the saved search when the initial Workflow start fails so recovery can restart it. Never delete or duplicate customer demand merely because `workflowRunId` is temporarily absent.
5. The first check evaluates every selected course, records evidence, and sends the appropriate setup/status communication. A search beyond a provider's booking window should explain when booking is expected to open and sleep until the next useful course-local check rather than busy-polling.

### 3. Monitor And Notify

1. The per-search workflow wakes at `nextCheckAt` and runs against the latest deployment.
2. Each selected course is checked independently. Its course-local timezone, current technical access requirements, booking method, provider metadata, and requested physical layout determine what can run. Booking or transaction policy text alone does not make a public read-only surface ineligible.
3. Every course gets a check result; material observation changes and adapter attempts produce durable `CourseProbe` evidence, while unchanged unsupported facts may reuse the latest row. Supported availability becomes an idempotent `TeeTimeMatch`; one course's failure must not suppress another course's success.
4. New matching openings send email to the Clerk account email plus normalized additional recipients. Emails show course-local time as the booking source of truth and the golfer's timezone when it differs.
5. The email links to the official booking page. Availability is first come, first served, and the golfer completes the booking.

### 4. Manage Or Finish An Alert

- The owner-scoped dashboard shows saved searches, ranked courses, scheduler state, current matches, recipients, booking-window guidance, and management actions.
- Editing or resuming an active search increments its schedule version and starts a fresh workflow; stale workflow executions must not overwrite the newer schedule.
- Pause stops useful checks until resumed. `Check now` queues an immediate owner-authorized check without reviving a global poller.
- Removing a search deletes its `CoursePreference`, `CourseProbe`, and `TeeTimeMatch` rows but preserves reusable `Course` knowledge. A signed email stop marks it `COMPLETED` or `CANCELLED` and suppresses pending matches. Both paths must prevent future sends.
- `TeeTimeMatch.availabilityStatus` and `alertStatus` are separate: an emailed time may remain visible while still available, and a vanished unsent time should not be emailed later.

### 5. Recover From Missing Or Unsupported Coverage

- A missing discovery result goes through exact provider-shape inspection, direct lookup, official-site corroboration, and, when justified, a `GooglePlaceReview` correction.
- A monitoring gap goes through official-site discovery and durable `CourseAutomationDiscovery` evidence. Reusable support for public, signed-out, read-only availability belongs in an adapter. Phone-only, account-required, captcha/queue, private/non-course, or otherwise technically inaccessible surfaces are classified honestly; provider terms or booking policy alone are not a terminal monitoring disposition.
- `NEEDS_ADAPTER` and `FETCH_FAILED` can open a deduplicated `CourseSupportIncident`. The dedicated 10-minute course-support responder owns discovery, reusable implementation, fresh-runtime verification, retry, and final disposition; the broad hourly loop must not select these incidents. Ordinary one-check `TEST`/`AUTOMATION` searches remain excluded, but an explicitly opted-in `syntheticMultiCycle` search may open an `engineeringOnly` incident. Engineering-only incidents never send customer or operator support email, remain actionable after the source search ends, and must stay open until reusable monitoring works or a conclusive technical-access/contact/identity disposition is persisted. Real demand on the same course promotes the incident to normal customer-demand priority.
- Customer copy should say what Tee Time Spot can do now and offer the official site; do not expose terms such as adapter, probe, queue, Prisma, Neon, Codex, or automation incident.

### 6. Learn From Real Use

- `WebsiteEvent`, `WebsiteFeedback`, lookup misses, support incidents, probes, matches, and automation runs are the product-learning surfaces.
- Analytics are aggregate and traffic-classed as `PUBLIC`, `AUTOMATION`, `TEST`, or `UNCLASSIFIED`. Never add a persistent visitor/session identifier just to improve reporting.
- Automated and test browsers must identify their traffic so they do not masquerade as customer demand.
- Treat feedback as an input to diagnosis and prioritization, not as permission to bypass technical access controls or enter a booking transaction. Do not let booking-policy text override stronger current evidence that a surface is publicly readable.

## Canonical Decisions

- Canonical product name: `Tee Time Spot`.
- Canonical domain: `teetimespot.com`.
- The repo folder and GitHub repo can still be named `TeeTimeAI`.
- V1 notification channel: email only.
- No SMS until email demand is proven.
- No payments or marketplace checkout in the POC.
- Clerk is the account system, but `CLERK_AUTH_READY` gates production account mode.
- Signed-out visitors may browse courses, but creating, changing, pausing, or stopping alerts requires a Clerk account.
- The authenticated Clerk account email is always the primary recipient; a search may add up to 3 deduplicated additional recipients.
- Google Places is used for course discovery and photos.
- Course discovery defaults to a 15-mile radius and offers 5 to 30 mile choices.
- Discovery should prefer public golf courses and filter stores, simulators, private clubs, and likely non-course results.
- Exact Google Place review facts live in Neon and can take effect without a code deployment; reusable generic filtering rules remain code.
- A physical 9-hole/18-hole course layout is different from a purchasable round length. Use verified `Course.layoutHoleCounts` evidence and never infer physical layout from tee-sheet products alone.
- Search windows are evaluated in each course's IANA timezone. `TeeSearch.userTimeZone` is for recipient-facing context, not for redefining a course-local booking window.
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
- `Course`: canonical reusable course snapshot, including identity, location/timezone, physical layout evidence, booking method/window, provider metadata, policy, and automation eligibility.
- `GooglePlaceReview`: exact-ID, evidence-backed provider access/identity/alias review; it is not a playable course catalog row.
- `TeeSearch`: owner-scoped saved demand plus scheduler state.
- `CoursePreference`: ranked course list.
- `CourseProbe`: per-course automation observation.
- `TeeTimeMatch`: normalized matching slot.
- `AutomationRun`: durable poll/improvement run record.
- `CourseAutomationDiscovery`: append-only provider/booking discovery evidence; an accepted finding can update the reusable `Course` snapshot.
- `CourseSupportIncident`: one deduplicated unresolved monitoring incident per course, including provider family/fingerprint, retry schedule, and demand priority.
- `CourseSupportBatch` / `CourseSupportBatchIncident`: durable ownership, provenance, lease, release verification, and per-course results for one responder provider-family/fingerprint batch.
- `WebsiteEvent`: engagement event.
- `WebsiteFeedback`: user feedback.

### System Ownership Boundaries

- **Clerk owns authentication and account identity.** Neon stores the app's `User` mapping and product state. Never expose another owner's search when Clerk is unavailable, and never fall back to a global recent-search dashboard.
- **Google Places owns transient place data.** The app owns conservative filtering, exact reviewed corrections, deduplication, and the choice to present a result as likely public.
- **Neon Postgres is the durable source of truth.** Dashboard/search state, schedules, provider reviews, probes, matches, incidents, analytics, and automation history must survive process restarts and deploys.
- **Vercel Workflow owns per-search scheduling.** It orchestrates sleep/wake/check behavior; Postgres schedule version, row-token lease, and compare-and-set completion prevent stale workflow work from winning.
- **Vercel Queue is only a Workflow-start fallback.** Its private, minimal, at-least-once messages recover failed starts and dispatch one post-remediation recheck; Postgres remains authoritative.
- **Course adapters read public, signed-out availability without transacting.** The official provider remains authoritative for current availability, price, rules, and booking.
- **Resend transports email.** A local `SENT` record means the send path completed/provider accepted it; it is not proof of inbox placement or an open.
- **Vercel Git deployments own production runtime.** A successful local build or database write is not proof that the matching application commit is live.
- **The course-support Codex responder owns provider coverage incidents.** It runs every 10 minutes and resolves them with reusable support or final evidence-backed dispositions.
- **The hourly Codex loop owns broad product engineering improvement.** It is separate from customer search workflows, excludes course-support incidents, and must not be used as the scheduler.

### Application Surfaces And API Boundaries

- `/` and `/search`: public intake/discovery and ranked shortlist; authentication is required only when saving.
- `/dashboard`: authenticated, owner-scoped alert management. When account/database setup is unavailable, render a safe setup/signed-out state with no cross-owner fallback data.
- `/email-preview`: side-effect-free sample rendering of the real alert design.
- `/guides/public-golf-booking-windows`: customer explanation of provider booking-window behavior.
- `/alerts/stop`: confirmation surface for signed bounded email actions.
- `/api/location/geocode`, `/api/courses/discover`, `/api/courses/lookup`, and `/api/courses/photo`: public provider-backed reads with bounded inputs and safe failure responses.
- `/api/searches` and its item/check actions: authenticated and owner-scoped. Creation, edit, pause/resume, explicit check, and delete must enforce the same ownership server-side.
- `/api/feedback` and `/api/analytics/events`: public, validated product-learning writes; traffic class is aggregate metadata, not identity.
- `/api/queues/search-schedule`: private Vercel Queue push consumer for strict Workflow-start messages. It is not a public mutation API and its payload must never contain recipient, course/provider, URL, or credential data.
- Automation mutation routes require `AUTOMATION_API_KEY`; recovery cron requires `CRON_SECRET`; email actions use `EMAIL_ACTION_SECRET`. These authorities are separate and must not be interchangeable.

Keep public discovery and lookup response shapes backward compatible unless the task explicitly calls for an API change. Provider or review implementation details belong behind those contracts.

### Persistence Boundary

There is no active SQLite or file-backed application database. Keep these in Neon:

- Accounts and customer demand: `User`, `TeeSearch`, `CoursePreference`.
- Course/provider knowledge: `Course`, `GooglePlaceReview`, `CourseAutomationDiscovery`, `CourseSupportIncident`, `CourseSupportBatch`, `CourseSupportBatchIncident`.
- Monitoring and delivery state: `CourseProbe`, `TeeTimeMatch`, `AutomationRun`.
- Product learning: `WebsiteEvent`, `WebsiteFeedback`.

These are intentionally temporary and should not become database projects without a demonstrated need:

- Search-form URL/session prefill.
- Aggregate traffic/source markers.
- Provider cookies or request sessions.
- Request-local maps, review indexes, caches, and dedupe sets.
- Demo fixtures used outside production.
- Ignored local environment and provider-link files.

Do not add Redis, a warehouse, a read replica, another queue, or a full course-catalog cache for hypothetical scale. The current architecture is one app, one durable Postgres source of truth, per-search Workflows, and one bounded Vercel Queue fallback for Workflow starts/rechecks.

### Database Connection And Migration Rules

- Application/runtime traffic uses pooled `DATABASE_URL`.
- Prisma migrations prefer direct `DATABASE_URL_UNPOOLED`; on Windows, explicitly map it to `DATABASE_URL` for `prisma migrate deploy` when the CLI does not load the env file automatically.
- `npm run prisma:migrate` uses `prisma migrate dev` and is local-development-only. The production shape is `npx vercel env run -e production -- npx prisma migrate deploy`, after confirming that the command resolves the direct Neon URL.
- Missing database configuration may use localhost fallback only off Vercel. Never make a hosted deployment silently connect to localhost.
- In production, dependent discovery/geocode/search APIs and actions must fail closed, normally with a generic `503`, when required database or Google configuration is missing. The dashboard may render a safe setup state, and the photo proxy may return `404` when no provider photo can be served. Development and preview may use explicit demo fixtures.
- During Vercel build, Prisma client generation may use an inert placeholder only for generation. Runtime and migration commands must still require real configuration.
- Apply backward-compatible additive migrations before publishing application code that depends on them. Validate first on an isolated preview database when the change is material.
- Preserve query-aligned indexes for global history reads, including `AutomationRun.startedAt`, `(promptVersion, startedAt)`, `CourseProbe.observedAt`, `CourseAutomationDiscovery.createdAt`, and `TeeTimeMatch.firstSeenAt`.

## Environment And Secrets

Expected env names:

- `DATABASE_URL`
- `DATABASE_URL_UNPOOLED`
- `GOOGLE_PLACES_API_KEY`
- `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_API_KEY`
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID`
- `RESEND_API_KEY`
- `RESEND_EMAIL_DOMAIN`
- `ALERT_EMAIL_FROM`
- `OPERATOR_ALERT_EMAIL`
- `AUTOMATION_API_KEY`
- `CRON_SECRET`
- `EMAIL_ACTION_SECRET`
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
- `CLERK_SECRET_KEY`
- `CLERK_AUTH_READY`
- `NEXT_PUBLIC_SITE_URL`
- `VERCEL_AUTOMATION_BYPASS_SECRET` (protected preview smoke only)
- `GOOGLE_SITE_VERIFICATION` / `BING_SITE_VERIFICATION` (optional metadata tokens)

Rules:

- Never print secret values in final answers.
- Never commit secret values.
- Redact keys in docs and `AutomationRun.notes`.
- Normalize copied env values when code reads provider keys because copied values have previously included BOM/whitespace.
- Prefer provider dashboards, Vercel env vars, or ignored local env files for credentials.
- Keep the browser Maps key referrer-restricted and separate from the server Places key. Never expose a server key through `NEXT_PUBLIC_*`.
- Treat `CLERK_AUTH_READY` as a deliberate safety gate even when valid-looking keys exist; production account APIs should not partially enable themselves.
- If a setup action needs billing, payment methods, ownership transfer, legal acceptance, or domain purchase, get fresh explicit approval.

## Google Places Rules

Current nearby search:

- Uses Places API (New) `places:searchNearby`.
- Sends `includedPrimaryTypes: ["golf_course"]` for the typed nearby passes.
- Requests only needed fields.
- Uses `places:searchText` style geocoding for typed location fallback.
- Uses `/api/courses/photo` as a proxy/redirect for transient Places photo references.

Filtering expectations:

- Normally require `primaryType` to be `golf_course` and `types` to include `golf_course`.
- Permit only the documented narrow exceptions: an active exact-ID `VERIFIED_PUBLIC` review or a strongly corroborated bounded public-course text result.
- Exclude non-operational places.
- Exclude known non-course primary types such as stores, indoor/simulator surfaces, sports clubs, and associations.
- Exclude known private/non-course name patterns.
- When the user reports a bad result, add focused tests around the real shape rather than broad string hacks.

Do not over-request fields. Keep field masks tight.

### Reviewed Place Facts

`GooglePlaceReview` is the durable source for evidence-backed facts about one exact Google Place ID:

- `accessOverride` may be `VERIFIED_PUBLIC`, `VERIFIED_PRIVATE`, `VERIFIED_NON_COURSE`, or null when the review only corrects identity/alias behavior.
- `name`, `classification`, `evidenceUrl`, and `reviewedAt` explain what was reviewed and why.
- `active=false` preserves history while removing the review from runtime behavior.
- `canonicalPlaceId` plus canonical name/address/site/phone can collapse an alias into the real place and correct provider identity. Review coordinates support radius targeting for verified-public recovery; ordinary candidate mapping still uses current Google coordinates.
- `retainWhenCanonicalAbsent` keeps a reviewed alias only when the canonical result is not present in that provider response.

Runtime rules:

- Load all active place reviews once per discovery or lookup request and reuse the in-memory index for that request.
- Exact-ID access reviews control recovery/exclusion before generic heuristics. Identity corrections and alias collapse happen without changing the public API response shape.
- A review-read failure must return a generic `503`; never bypass known private/non-course exclusions because Neon is unavailable.
- Generic, reusable classification and distance rules remain code. Do not migrate every heuristic into rows.
- `Course.isPublic` remains a course snapshot field. Provider review rows must not masquerade as playable `Course` records.
- The old hardcoded public/private/non-course/identity/alias registries must not return. Add or correct evidence through the operator command.
- Woodhaven's verified nine-hole layout belongs on its existing `Course` row. Do not reintroduce a runtime `CURATED_COURSE_LAYOUTS` fallback.

Operator command:

```powershell
npm run automation:place-review -- upsert --place-id <place-id> --name <review-name> --classification <classification> --evidence-url <https-url> --reviewed-at <YYYY-MM-DD> [options]
npm run automation:place-review -- upsert --place-id <place-id> --inactive [--apply]
```

- The command is dry-run by default; `--apply` is required for writes.
- `--apply` writes to whichever database environment is loaded. Confirm the target explicitly and inspect the dry-run output before touching production.
- Use it for upsert and deactivation. This is operator-only by current design; do not add a public write API or admin UI without an explicit new product/security decision.
- Validate an HTTP(S) evidence URL with no embedded credentials, date, paired coordinates, canonical alias requirements, and retention requirements before applying.
- Review changes must include focused tests for verified-public recovery, private/non-course exclusion, identity correction, canonical alias collapse, retained alias behavior, inactive rows, and ordinary positive public-course controls.

## Automation Loop Contract

There are three related but different automation workflows.

### Event-Driven Search Checks

Production search checks are owned by a durable per-search Vercel Workflow. Creating, editing, resuming, or explicitly checking an active search starts a workflow immediately. After each check it sleeps until that search's next useful check time, then starts the next run on the latest deployment.

Preferred commands:

```powershell
npx vercel env run -- npm run automation:poll
npx vercel env run -- npm run automation:inspect
```

Important behavior:

- `automation:poll` is a manual recovery command, not a recurring production scheduler. It only uses a guarded compare-and-set to persist due `WAITING` searches as `QUEUED`; it never starts Workflow from the local operator process.
- A five-minute safety-recovery cron performs a lightweight database query for overdue/stuck schedules, due email-outbox retries, and locally queued operator/remediation requests. A queued request with no attached Workflow becomes eligible after two minutes; an attached queued run and other overdue states retain the ten-minute safety threshold. Normal search and delivery retries remain inside the durable per-search Workflow and must wake no later than the persisted delivery retry time.
- `TeeSearch.checkStatus`, `nextCheckAt`, `lastCheckedAt`, `lastCheckOutcome`, `workflowRunId`, `checkLeaseToken`, `checkLeaseExpiresAt`, and `recheckRequestedAt` describe scheduler state.
- `TeeSearch.scheduleVersion` invalidates older workflow executions after edit, pause, resume, cancellation, or an explicit new schedule.
- A 15-minute row-token lease owns one check while network work runs outside a database transaction. Heartbeat and compare-and-set completion on search id, schedule version, and token prevent stale evidence. A generation-scoped `SearchEmailDelivery` outbox serializes recipient/intent mutations against active sends and retries immutable payloads with stable idempotency. Owner delivery finalizes the customer-visible match/status independently, while each additional recipient retains its own durable retry state. A busy check persists `recheckRequestedAt` for immediate follow-up.
- Immediate Workflow start failures inside the deployed runtime may use the private `tee-time-spot-search-schedule` Vercel Queue fallback. Local operator and course-remediation runs persist guarded `QUEUED` state for the deployed recovery cron instead of publishing a development-scoped queue message. The strict queue payload is only search id, schedule version, and trigger; retention is 24 hours, consumer concurrency is 2, and Postgres remains the recovery source of truth.
- `TeeSearch.status` is the customer lifecycle (`ACTIVE`, `PAUSED`, `COMPLETED`, `CANCELLED`); `checkStatus` is execution state (`IDLE`, `QUEUED`, `CHECKING`, `WAITING`, `FAILED`, `STOPPED`). Do not collapse them into one field.
- Valid base cadence values are 5, 15, 30, 60, and 120 minutes. Booking-window scheduling may sleep longer until the next useful release event.
- A search expires at the latest absolute end of its selected courses' local requested windows, not at arbitrary server midnight.
- Booking-window intelligence may defer a course until its provider-confirmed release time. The workflow should wake at the next useful course event while still allowing other selected courses to run.
- If a known booking release occurs while the prior multi-course check is still running, schedule an immediate catch-up instead of applying the base cadence from completion time.
- `TeeTimeMatch.availabilityStatus` is independent from email `alertStatus`; emailed matches remain visible while they are still confirmed available.
- The truth is in Postgres: the `TeeSearch` schedule row, `AutomationRun`, newest per-course `CourseProbe`, `TeeTimeMatch`, `CourseSupportIncident`, and pending alerts.
- Use the newest observation for each course/search when classifying current health. A later `NO_MATCH` or success supersedes an older failure even though history remains valuable.
- Use `automation:inspect` to classify the result.
- Report normalized outcomes such as `success`, `no new matches`, `alerts sent/dry-run`, `blocked_env`, `needs_adapter`, `account_required`, or `captcha_or_queue`. Do not use `blocked_policy` as a terminal result for public read-only monitoring.
- Do not revive the retired 15-minute Codex poller.

The historical automation memory path for manual recovery runs is:

```text
C:\Users\Grim_Leaper\.codex\automations\teetimeai-active-search-poller\memory.md
```

### Course-Support Responder

The dedicated Codex responder runs every 10 minutes and exclusively owns open `NEEDS_ADAPTER` / `FETCH_FAILED` incidents. Start every task with:

```powershell
npm run automation:course-support -- inspect
```

Important behavior:

- A batch contains one `providerFamilyKey` plus one hashed failure fingerprint. Default to 5 courses and never exceed 20.
- The central provider-capability registry owns family detection, metadata validation, runnable support, failure classes, and consumer dispositions. Recognition alone is not runnable coverage.
- Claim only from a clean `automation/course-support-*` branch whose `HEAD` equals current `origin/main`; persist the real owner task and base SHA, inspect the ordinal-only packet, then claim every planned path before editing it. Heartbeat the 15-minute batch lease and persist the candidate release SHA immediately after commit.
- The responder and hourly loop share the transaction-scoped `tee-time-spot:repository-writer` lease for state transitions. A durable batch plus unfinished `AutomationRun` owns the implementation interval.
- The responder and hourly automations must use separate already-approved persistent checkouts; never point both schedules at one mutable Git worktree.
- Code remediation requires a new per-course runnable-provider proof snapshot from the exact deployed release: `CourseProbe.runtimeVersion` must equal the release SHA and the observation must be newer than the pre-claim/deployment and latest-incident boundaries. A Workflow id, layout skip, or older success is insufficient.
- Classification-only closeout requires a current, sufficiently confident official-source discovery that agrees with the persisted phone/contact/walk-in, no-online-booking, account-required, CAPTCHA/queue, or other technical-access disposition. Provider terms or a prohibited-automation statement alone cannot close public read-only monitoring work. Exact private/non-course identity remains in the reviewed-place path.
- Terminal closeout waits for complete affected-search dispatch, healthy scheduler state, and a fresh post-dispatch check. Global provider I/O is capped at two requests and one request per provider family.
- Retry transient failures on the persisted 15-minute, 1-hour, 6-hour, then 24-hour ladder with jitter; honor bounded rate-limit `Retry-After`. Explicit recovery requires expired ownership and exact branch/HEAD/dirty-path provenance.
- Auto-archive only routine results after durable closeout: no due work, durably deferred busy, success, classification-only, partial, or retryable failure with a future `nextAttemptAt`. Keep active/recovery/human, privacy, delivery, unsafe-provider, migration/deploy/production-verification, auth/env/Git, command, and repeated-SLA tasks visible.
- Backfill is dry-run by default and must not call providers. Apply the additive migration before dependent code, inspect backfill output, then use `backfill --apply`.
- The full contract and command syntax are in `docs/course-support-responder.md`.

### Hourly Improvement Loop

The hourly improvement loop is allowed to improve the product when evidence supports a change, but only when no responder batch is active and no course-support work is due. Course-support incidents are excluded from its candidate portfolio.

For this hourly workflow, `no_op` is not a valid terminal outcome. An empty first queue or a healthy baseline is the nonterminal state `exploration_required`: rotate to least-recently covered locations, devices, routes, feedback, course gaps, accessibility, performance, security, metadata, and current-practice evidence until the run finds a safe valuable improvement or a concrete blocker. This rule does not change legitimate `no_op` behavior for event-driven search checks or browser probes.

It should:

- Run or inspect queue state.
- Run UI smoke.
- Identify the highest-leverage blocker or improvement.
- Use current tool/design research when UI/tooling is weak.
- Implement one coherent batch of compatible improvements that can be completed and verified safely in the run.
- Verify with tests, lint, build, and browser smoke.
- Record outcome, changed files, and blockers.

Required checkpoints:

- `queue_confirmed`
- `candidate_selected`
- `provenance_recorded`
- `tool_research_done`
- `ui_smoke_done`
- `verification_done`
- `outcome_recorded`

Do not mark a checkpoint true unless it happened.

Before the first file edit, persist durable `AutomationRun` provenance containing the automation id, owner run and Codex thread, branch, starting and expected `HEAD`, and every planned path. Add paths to the durable plan before expanding the edit. A dirty checkout may be resumed only when the immediately preceding unfinished run belongs to the same hourly automation and its recorded branch, expected `HEAD`, owner run, owner thread, and complete planned-path set match exactly; otherwise stop with `blocked_dirty_worktree`.

Use `npm run automation:improve` to prepare the unfinished owner row, `npm run automation:improve -- claim --run-id <id> --path <path>` before edits, and pipe the structured terminal JSON to `npm run automation:improve -- closeout --run-id <id>`. Use `--owner-thread` only when `CODEX_THREAD_ID` is unavailable and the actual current Codex thread id is known. Dirty recovery requires a separate same-thread `--recover-run <id>` invocation; never infer the claim from the latest row.

Acquire the shared transaction-scoped `tee-time-spot:repository-writer` lease before candidate selection, path claims, or closeout. It serializes those transitions with the responder; due responder work, an active responder batch, or an active hourly run is `blocked_concurrent`. The single unfinished owner `AutomationRun` is the durable guard for the rest of the run. Keep `outcome_recorded=false` during preparation, editing, and verification; set it true only in the same closeout write that records `completedAt` and the terminal outcome. Terminal exceptions must close the owned run with a redacted error and concrete blocker.

Enter closeout no later than 40 minutes after the run starts or when only 20 minutes remain before the next scheduled launch. Start no new exploration or edits after that point; reserve the closeout budget for tests, diff review, commit, rebase, push, deployment, production verification, and the durable final record.

Every automated browser context must set session storage key `tee-time-spot:traffic-class` to `AUTOMATION`; explicit manual test contexts may use `TEST`. Do not add a persistent visitor/session identifier, and do not allow unmarked automation traffic to persist as public funnel evidence.

## Course Automation Rules

Before fetching a tee sheet:

- Confirm the official booking source and whether its availability is currently public and readable while signed out.
- Check `Course.automationEligibility` and `Course.policyNotes` as historical evidence, not as unquestioned authority. Re-check the live public surface when either says `BLOCKED` or `BLOCKED_POLICY`.
- Check the requested physical layout against verified `Course.layoutHoleCounts`; skip a known mismatch before provider retrieval.
- Never infer that booking, reservation, purchase, or checkout restrictions prohibit read-only monitoring. Policy text alone does not determine monitoring eligibility.
- If public availability can be read without bypassing a technical access control, monitoring is allowed regardless of provider or course terms.
- Skip retrieval only when current evidence shows that the read itself requires an account-specific/private session, an active captcha or waiting-room token, access-control circumvention, or another prohibited technical bypass. A stored `BLOCKED` value is not sufficient without that current evidence.
- Do not record `BLOCKED_POLICY` for a public read-only monitoring surface. Use the precise technical disposition, such as `ACCOUNT_REQUIRED` or `CAPTCHA_OR_QUEUE`, only when current observed behavior supports it.
- Record `NEEDS_ADAPTER` for unsupported public platforms when no technical access boundary has been demonstrated.
- Record `NO_MATCH` for supported checks with no qualifying time.
- Record `MATCH_FOUND` when a slot qualifies.

Adapter behavior:

- Use public, signed-out tee-sheet endpoints only.
- Distinguish visible UI from network access requirements. An invisible or background captcha token is still a captcha requirement even when the golfer sees no checkbox; do not generate, replay, solve, or bypass it.
- Run official-site/provider discovery before declaring a new course unsupported, and append evidence to `CourseAutomationDiscovery`.
- Treat contradictory provider platform, booking URL, and metadata signals as non-runnable source conflict. Do not call any provider until current official-source evidence reconciles them to one family.
- Prefer stable source IDs to dedupe matches.
- Do not alert duplicate matches.
- Do not suppress successful probes for one course because another course failed.
- Keep per-course evidence and failure notes.
- Reconcile availability separately from delivery. Mark missing observed slots `GONE` only under the reconciliation rules, and suppress vanished unsent matches.
- Treat recurring unsupported/fetch failures as one durable course incident rather than writing or emailing the same unresolved fact every five minutes.
- Resolve a course incident only after monitoring succeeds or a source-backed direct-booking classification is verified. Notify resolution only when a prior owner escalation was actually sent.
- Limit provider retrieval to two concurrent requests and never run two calls for the same provider family concurrently. Lease discovery follow-ups by their actual destination family and keep multi-request adapter steps sequential.
- Use the per-search row-token lease for long checks and transaction-scoped Postgres advisory leases only for short state transitions; session-level locks and network calls inside database transactions are unsafe with pooled Neon connections.

## Current Adapter Map

Do not assume every `DetectedPlatform` enum has a runnable adapter.

- Runnable families: `FOREUP`, `TEEITUP`, `CHRONOGOLF`, `CPS`, `CHELSEA`, `TEESNAP`, `GOLFBACK`, `WEBTRAC`, and `CLUB_CADDIE`, each only when the registry validates its required metadata.
- Recognized but non-runnable today: `GOLFNOW`, `WHOOSH`, and `TENFORE`; finding one is not evidence that monitoring is implemented.
- `UNKNOWN` means provider discovery is still needed, not that the course is unsupported forever.

Use the registry's consumer dispositions rather than optimistic support labels. Only a current trusted `MATCH_AVAILABLE`, `CHECKED_NO_MATCH`, or `BOOKING_NOT_OPEN` result counts as effective monitored coverage. Direct-site, phone/walk-in, account-required, CAPTCHA/queue, private/invalid, source-unverified, retrying, and engineering states must remain distinct. Treat `policy-blocked` as a legacy state that requires live revalidation, not a terminal result for public read-only monitoring.

Before adding an adapter, search existing provider dispatch, metadata parsers, seeds, and tests. Extend a reusable family when the public endpoint contract matches; do not create course-name-specific fetch code.

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

## Diagnosis And Repair Playbook

Fix the smallest authoritative layer that is wrong. Do not start with a broad refactor or a one-off database edit just because the symptom is visible there.

### Establish The Real Symptom

1. Reproduce the exact customer route, account/search, location, course, date, viewport, email type, or workflow named in the report.
2. Decide whether the request is diagnosis-only or authorizes a change. Read-only investigation must not mutate alerts, provider state, Git, or production data.
3. Check current source-of-truth state before relying on screenshots, old probes, or memory. Mask customer identifiers in normal reporting.
4. Preserve at least one known-good control near the failure. A precision fix that removes valid courses or a scheduler fix that stops healthy searches is not complete.

### Isolate The Layer

- **UI/layout:** inspect the live DOM, computed styles, accessible names, viewport geometry, console, and same-origin failures. Confirm data is present before changing queries or Postgres.
- **Authentication/ownership:** verify Clerk readiness, authenticated identity, `User.clerkUserId`, owner-scoped query, and API status. Never repair privacy failures with client-only hiding.
- **Discovery:** compare raw Google shape, active `GooglePlaceReview`, generic classifier output, dedupe result, API response, and rendered list. Use stable exact Place IDs for exceptions and test nearby public controls.
- **Saved search:** inspect the authenticated API result and `User`/`TeeSearch`/`CoursePreference` transaction. Confirm primary email came from Clerk, ranks are unique, and selected course candidates resolved to the intended canonical `Course` rows.
- **Scheduling:** inspect `TeeSearch.status`, `checkStatus`, `scheduleVersion`, `workflowRunId`, `nextCheckAt`, recent Workflow/`AutomationRun` outcomes, and the newest probe per course. Do not diagnose from one old failure row.
- **Provider monitoring:** inspect `Course` eligibility/reason/policy/booking metadata, newest probe, append-only discovery evidence, and open support incident. Confirm the official booking surface and current signed-out technical access requirements before changing an adapter; policy text is context, not a monitoring gate.
- **Matches/email:** inspect current matches, availability vs alert state, status snapshot, recipients, idempotency behavior, and provider send result. "Sent" does not prove inbox delivery; never promise open/delivery proof the available evidence cannot provide.
- **Deployment/configuration:** verify the exact Git SHA, applied migrations, Vercel deployment source/aliases, environment presence without printing values, live routes, and logs. Local success is not production proof.
- **Quick route probes:** use the real contracts: geocode takes `q`; discover takes `latitude`, `longitude`, and `radiusMeters`; lookup takes `q` plus either both coordinates or neither. Wrong probe shapes create false failures.

### Choose The Durable Fix

- Put reusable rules in typed domain code with focused tests.
- Put exact evidence-backed Google place facts in `GooglePlaceReview` through the protected operator command.
- Put canonical supported-course and automation facts on `Course`; preserve how they were learned in `CourseAutomationDiscovery`.
- Put customer intent and lifecycle on `TeeSearch`; do not infer it later from analytics or email history.
- Put recurring monitoring failures in `CourseSupportIncident`; keep individual observations in `CourseProbe`. Use `engineeringOnly=true` only for explicit multi-cycle synthetic coverage, never as a substitute for normal customer-demand ownership or notification state.
- Keep UI state local when it is merely presentation/prefill. Do not create database models for transient form state.
- Prefer additive schema changes and backward-compatible rollouts. Do not combine a migration with unrelated UI redesign.
- When correcting live data, also fix the path that produced the bad data and add a regression test; otherwise the next discovery or workflow can recreate it.

### Common Failure Patterns To Avoid

- Broad name substrings for one bad Google result; they produce false positives in other markets.
- Treating a missing Google result as nonexistence instead of a provider-recall problem.
- Letting database/review failures bypass private or non-course exclusions.
- Creating duplicate `Course` rows for alternate provider IDs and losing existing adapter metadata.
- Inferring physical course layout from a purchasable round length.
- Showing another user's search when account mode or Clerk is unavailable.
- Re-running the manual poller to hide a broken per-search Workflow.
- Counting automation/test traffic as customer conversion.
- Hiding an unsupported course without giving the golfer an official direct-booking path.
- Running build and Playwright concurrently against the same `.next` directory; missing-manifest errors from that race are not product defects.
- Updating production aliases with a second CLI deployment after a normal Git release.

### Repair Completion Criteria

A repair is complete only when:

- The named failing case passes at the layer where it broke.
- Relevant positive controls still pass.
- Durable state and user-visible state agree.
- Tests cover the actual provider/data shape, not a simplified guess.
- Schema changes are migrated and read back.
- Production work verifies the exact deployed commit, routes, workflow/data outcome where relevant, and recent error logs.
- Unrelated work remains untouched and Git parity is reported accurately.

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

Add focused verification for the layer changed:

- Google review changes: dry run, apply/upsert, deactivation, invalid input, active/inactive runtime behavior, private/non-course exclusions, verified-public recovery, identity correction, alias collapse/retention, and unrelated public controls.
- Persistence migrations: apply to an isolated database, verify backfilled uniqueness/counts/classifications/indexes, and read back protected canonical rows such as Woodhaven before production rollout.
- Search/scheduler changes: verify create/edit/pause/resume/check/delete ownership, schedule-version invalidation, recovery behavior, newest probe state, pending alerts, and at least one real Workflow cycle when production behavior changed.
- Email changes: render preview plus setup/status/instant/stop-action cases, recipient dedupe, idempotency/retry behavior, and safety copy.
- Discovery fixes: use the exact reported provider payload and location plus multiple positive/negative controls in different markets.
- UI fixes: verify the exact reported viewport and interaction first, then the desktop/mobile smoke matrix; inspect screenshots when layout was the problem.

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

For a backward-compatible schema-dependent release, apply and verify the reviewed additive migration first using the direct Neon URL, then publish the application commit that depends on it. Never deploy code that queries a not-yet-applied schema. Use a staged compatibility plan when a change cannot be safely additive.

Normal production deployments are owned by the Vercel Git integration. After the verified
task branch is fast-forwarded to `main`, wait for the Git-created deployment for that exact
commit:

```powershell
git push origin HEAD:main
npm run deployment:wait -- --sha <commit-sha>
```

Do not run `npx vercel --prod --yes` after a normal Git push. That creates a duplicate
deployment for the same commit and can move the production aliases away from the Git
deployment. A direct CLI production deployment is recovery-only and must be an explicit
choice with its reason recorded.

After deploy:

- Verify Vercel reports `Ready`.
- Verify the selected deployment source is Git and its commit matches the pushed SHA.
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

## Current State And Known Gaps

Provider/setup gaps can drift, so verify before acting. Last known items:

- Clerk account mode is active in production with owner-scoped dashboards and email/password plus Google sign-in. `CLERK_AUTH_READY` remains the required safety gate; verify live provider state before changing it.
- Google Places key should remain restricted and should be rotated after confirming healthy production behavior.
- Google place corrections are operator-command-only by design; there is no public/admin review editor.
- Adapter coverage is intentionally narrow; add adapters only with current evidence of public, signed-out, read-only retrieval that does not require bypassing a technical access control.
- Resend/provider acceptance is recorded, but the current architecture has no separate inbox-delivery/open ledger.
- Admin/reporting for feedback, events, probes, and adapter gaps can be improved.
- No Redis, warehouse, read replica, separate queue, or full course-catalog cache is currently justified.

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
npm run automation:place-review -- upsert --help
npm run deployment:wait -- --sha <commit-sha>
```

Use `npx vercel env run -- <command>` when a local automation command needs provider env vars.
