# Course knowledge page operations

Course profiles are fail-closed editorial records layered over the current operational `Course` facts. Saving an alert never waits for profile research, and an unpublished or blocked profile never disables the underlying alert.

## Initial Connecticut release

Apply the additive migration before running profile commands against an environment:

```powershell
npx vercel env run -e production -- npx prisma migrate deploy
```

Then validate the researched data and confirm that the live `ALLOWED` cohort has not grown beyond it:

```powershell
npm run automation:course-profile -- validate-seeds
npx vercel env run -e production -- npm run automation:course-profile -- cohort
npx vercel env run -e production -- npm run automation:course-profile -- backfill-connecticut
```

`backfill-connecticut` is a dry run unless `--apply` is present. A full dry run fails when the current Connecticut cohort includes a course without a researched seed. After a successful full dry run, publishing can be split into reviewable county batches:

```powershell
npx vercel env run -e production -- npm run automation:course-profile -- backfill-connecticut --county Fairfield --apply
npx vercel env run -e production -- npm run automation:course-profile -- backfill-connecticut --county "New Haven" --apply
```

The researched snapshot contains 26 supported Connecticut courses as of July 15, 2026. Always trust the live cohort check over this count.

## Ongoing queue

The hourly inspection output separates ready `courseProfileQueue` work from
`courseProfileLocationQueue` records that still need authoritative city/state
evidence. Missing location data stays visible in queue health instead of
blocking actionable guide refreshes. Research and publishing remain separate,
dry-run-first actions:

```powershell
npm run automation:course-profile -- queue --limit 3
npm run automation:course-profile -- research --course-id <course-id>
npm run automation:course-profile -- upsert --file <draft.json>
npm run automation:course-profile -- upsert --file <draft.json> --apply
```

When an official course or booking page states a dependable release rule, record it on the operational course separately from the editorial profile. The command is dry-run-first and stores the source URL used for the time-sensitive claim:

```powershell
npx vercel env run -e production -- npm run automation:course-profile -- booking-window --course-id <course-id> --days-ahead <days> --release-time <course-local-time> --evidence-url <official-url>
npx vercel env run -e production -- npm run automation:course-profile -- booking-window --course-id <course-id> --days-ahead <days> --release-time <course-local-time> --evidence-url <official-url> --apply
```

Omit `--release-time` only when the official source verifies the number of days but not a release time. ForeUP courses will reuse the stored official evidence URL during later booking-window refreshes.

Validation requires authoritative sources, claim keys for every notable fact, original wording, and a current verification date. A failed first-time draft becomes `BLOCKED_EVIDENCE`; a failed refresh preserves previously published content as `STALE` with its prior review date and records the refresh failure for another attempt. Published profiles are queued for review after 180 days, but their content does not expire or disappear because of age. A material change to course identity, access, support, official website, or booking URL immediately marks the profile stale and queues revalidation while keeping the last published guide available.

Profile drafts may also carry source-backed `physicalLayout` and `par` objects.
Their evidence URL must match a listed source carrying the `physical_layout` or
`par` claim, respectively. Applying a valid draft updates the reusable Course
record and observation date. Never infer a physical layout from tee-sheet round
options.

Write every public profile as a confident facility guide. State supported facts directly and focus on the course layouts, setting, amenities, ownership, public access, and playing experience. Keep claim keys, evidence summaries, authority checks, and uncertainty about the research process internal. Public prose must not say “what Tee Time Spot understands,” “what we know,” “our research found,” “not enough evidence,” or similar editorial-process language. When one fact is unavailable, describe only that field conservatively and direct the golfer to the official course or booking page.

When an older course URL must redirect to a replacement profile, add the stored alias only after a dry run:

```powershell
npm run automation:course-profile -- alias --course-id <replacement-course-id> --slug <retired-slug>
npm run automation:course-profile -- alias --course-id <replacement-course-id> --slug <retired-slug> --apply
```
