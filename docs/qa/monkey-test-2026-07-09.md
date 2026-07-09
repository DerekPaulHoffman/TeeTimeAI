# Tee Time Spot Monkey Test - 2026-07-09

## Commands

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/
node scripts\qa\monkey-test-teetime-spot.mjs
npx vercel env run -- npm run automation:poll
npx vercel env run -- npm run automation:inspect
```

## Browser Run

- Base URL: `http://127.0.0.1:3000`
- Run id: `2026-07-09T15-16-00-079Z`
- Test email: `codex-monkey-1783610160079@example.com`

## Actions Recorded

| Step | Result |
| --- | --- |
| Open home page | OK |
| Submit broken feedback | Saved |
| Jump to search form | OK |
| Find courses for `Trumbull, CT` | OK, 17 courses |
| Add first five courses | OK, selected counts 1, 2, 3, 4, 5 |
| Inspect added course row unadd affordance | Course-list button becomes disabled `Added` |
| Try adding sixth course | Limit error shown |
| Remove selected course from summary X button | OK, selected count 5 to 4 |
| Re-add removed course from course list | OK, selected count back to 5 |
| Same-day date validation | Save disabled |
| End-before-start validation | Save disabled |
| Submit real alert search | Saved |
| Open dashboard after submit | OK, heading `Your tee time alerts` |
| Open email preview | OK, iframe visible |
| Mobile feedback panel | OK, no horizontal overflow |

## API Results

- `POST /api/feedback`: `201`
- `POST /api/searches`: `201`
- `POST /api/analytics/events`: `201` during normal interactions

Observed aborted requests were from navigation/image cleanup and beacon unload behavior:

- Course photo requests aborted during navigation.
- Several Next `_rsc` requests aborted during route changes.
- A few analytics beacon requests aborted during navigation. Earlier analytics posts succeeded with `201`, so this did not block the user flow.

## Poller Readback

`automation:poll` exited `0` and emitted a dry-run email alert:

- To: `codex-monkey-1783610160079@example.com`
- Course: `Oak Hills Park Golf Course`
- Starts at: `2026-07-10T19:30:00.000Z`
- Booking URL: `https://foreupsoftware.com/index.php/booking/22739/11739#/teetimes`

`automation:inspect` confirmed:

- Latest run: `cmrdng6590000fg15oug86mnz`
- Outcome: `success`
- Notes: `Processed 1 active searches.`
- Active search id: `cmrdnftk000086s15w910v9xh`
- Probe counts: `MATCH_FOUND: 1`, `NEEDS_ADAPTER: 4`
- Match: `Oak Hills Park Golf Course`, source `foreup-11739-2026-07-10 15:30`
- Alert status: `SUPPRESSED`
- Pending alerts: `[]`

## Findings

1. The add/unadd UX is confusing.
   - After adding a course, the course-list row changes to a disabled `Added` button.
   - Users can remove the course only from the right-side summary panel using the `X` button.
   - This matches the reported confusion: clicking `Add` does not turn into a same-place `Remove` or `Unadd` action.

2. The poller did process the submitted monkey-test search.
   - It found a real supported-course match for Oak Hills.
   - It dry-ran the alert and persisted the match.
   - Unsupported selected courses produced expected `NEEDS_ADAPTER` probes.

3. The new feedback and analytics endpoints are working in the tested environment.
   - Feedback returned `201`.
   - Analytics returned `201` during normal page interactions.

## Automation Seed

The reusable browser script is:

```powershell
node scripts\qa\monkey-test-teetime-spot.mjs
```

Use `MONKEY_BASE_URL` to point it at another deployment:

```powershell
$env:MONKEY_BASE_URL = "https://your-preview-or-prod-url"
node scripts\qa\monkey-test-teetime-spot.mjs
```
