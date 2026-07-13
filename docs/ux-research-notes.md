# UX Research Notes

## 2026-07-13: Phoenix discovery needs official identity recovery

- Sources: [Arizona Grand Resort's official golf page](https://www.arizonagrandresort.com/golf/) identifies one public Arizona Grand Golf Course, links its official tee-time site, and lists the resort at 8000 S Arizona Grand Parkway; [Ahwatukee Golf Club's official site](https://www.ahwatukeegolf.com/) identifies the public course at 12432 S 48th Street with phone 480-893-1161 and its official tee-time link. Both current 2026 surfaces were accessed 2026-07-13 America/New_York. [Google Places place ID guidance](https://developers.google.com/maps/documentation/places/web-service/place-id) says Place IDs can be stored and reused but should be refreshed when stale.
- Tee Time Spot evidence: a real signed-out `85001` search at 30 miles returned 45 records locally and 42 on a production readback. Arizona Grand appeared twice, while the Ahwatukee property appeared as three separate generic `Golf Course` pins. A provider-backed candidate recheck returned a second Arizona Grand secondary identity at 9201 S 51st Street. The official Arizona Grand surface names one course at 8000 S Arizona Grand Parkway, and Ahwatukee's official site names one public course at 12432 S 48th Street.
- Decision: map the exact verified Arizona Grand and Ahwatukee Place IDs to their official identities. When a canonical Place ID is present, suppress its verified aliases; when Google returns only aliases, retain one mapped course so incomplete provider identity data cannot erase a real public course. Leave the unresolved generic `ChIJq6qqBnIGK4cRPpgjylaZoIo` pin in Tempe visible until direct official evidence ties that Place ID to a specific course. Do not infer identity from proximity, a generic name, or city alone.

## 2026-07-13: State-border discovery needs exact identity corrections

- Sources: [The Barn At Fox Run official site](https://www.thebarnatfoxrunvt.com/) (accessed 2026-07-13), [Baker Hill membership FAQ](https://www.bakerhill.org/guest-information/frequently-asked-questions) (accessed 2026-07-13), [Dublin Lake Club private site](https://home.dublinlake.org/default.aspx?E=6&p=home) and [current access listing](https://www.allsquaregolf.com/golf-courses/new-hampshire/dublin-lake-club) (accessed 2026-07-13), [Stratton official course tour](https://www.stratton.com/things-to-do/activities/stratton-golf/tour-the-course) (current 2026 course surface, accessed 2026-07-13), and [Google Places API place IDs](https://developers.google.com/maps/documentation/places/web-service) (updated 2026-07-08, accessed 2026-07-13 America/New_York).
- Tee Time Spot evidence: a real signed-out `05101` search at the 30-mile ceiling returned 11 records spanning Vermont and New Hampshire. The first six visibly labeled the Fox Run wedding venue as `Public` and showed two Google pins for the same Stratton course. Expanding the results exposed Baker Hill, whose official membership process requires an application, interview, sponsors, and recommendation letters, plus Dublin Lake Club's member-gated course. Google continued to return every record as a golf course and the semantic public-course query corroborated them.
- Decision: exclude the exact Barn, Baker Hill, and Dublin Lake place IDs before accepting type or public-query evidence, and map the secondary Stratton pin to its official 251 Stratton Mountain Road identity. Keep Hooper, Bretwood, Fox Run, the canonical Stratton record, and other unverified facilities visible. Stable IDs avoid broad `Barn`, `Club`, or same-website heuristics that could remove real public facilities or distinct resort layouts.
## 2026-07-13: Empty searches need bounded recovery and feedback needs focus management

- Sources: [W3C WAI-ARIA Dialog (Modal) Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) and [W3C Modal Dialog Example](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/dialog/) (last updated 2026-03-04), accessed 2026-07-13 America/New_York.
- Tee Time Spot evidence: a real signed-out `59001` search returned zero public courses at the default 15 miles on desktop and mobile. The page stated the count but offered no direct next step even though the product contract already defines a 5-to-30-mile discovery range. The live controls had drifted to 1-to-50 miles. Keyboard testing also found that opening the feedback panel left focus on the document body, exposed no dialog landmark, ignored Escape, and returned focus to the body after closing.
- Decision: restore the documented 5-to-30-mile range on both search entry points, turn zero results into an announced action that can rerun the same coordinates at 30 miles, and keep the course-name lookup as the fallback after the full range is exhausted. Give the non-modal feedback panel a programmatic dialog name, move focus inside when it opens, close it with Escape, and return focus to the launcher when it closes.

## 2026-07-13: Miami discovery needs stable identity exclusions

- Sources: [Green Girls Golf official site](https://www.greengirlsgolf.com/), [Golf Miami 305 official site](https://www.golfmiami305.com/), [Shell Bay Club official site](https://shellbayclub.com/), [South Florida Golf Magazine business listing](https://nextdoor.com/pages/south-florida-golf-magazine-miami-beach-fl/), and [Celebrity Amputee Golf Classic nonprofit record](https://projects.propublica.org/nonprofits/organizations/454693128), accessed 2026-07-13 America/New_York.
- Tee Time Spot evidence: a real signed-out `33139` search at 30 miles returned Green Girls Golf, South Florida Golf Magazine, and Celebrity Amputee Golf Classic among the first six results, ahead of actual public courses. The full API payload also returned the Golf Miami 305 simulator, a PGA TOUR delivery listing, and invitation-only Shell Bay Club. All were labeled `Public` because Google still supplied them as `golf_course` records and the semantic public-course query corroborated their place IDs.
- Decision: exclude the six exact Google place identities before type or semantic-public corroboration. Green Girls Golf is a caddie/event service, South Florida Golf Magazine is a publication, Celebrity Amputee Golf Classic is a nonprofit event, Golf Miami 305 is an indoor Trackman facility, PGA TOUR Deliveries is a delivery listing, and Shell Bay documents private membership. Do not add broad `Classic`, `Magazine`, `Deliveries`, or generic business-name heuristics; the ambiguous `xie` and generic `Golf Course` pins remain visible until their identities are resolved.

## 2026-07-13: Search needs programmatic link names, AA contrast, and a discoverable LCP image

- Sources: [WCAG 2.2 SC 1.4.3 Contrast Minimum](https://www.w3.org/TR/WCAG22/#contrast-minimum), [W3C SC 2.4.4 Link Purpose](https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html) (updated June 2026), [Next.js Image documentation](https://nextjs.org/docs/pages/api-reference/components/image) (updated April 15, 2025), and [web.dev LCP guidance](https://web.dev/articles/optimize-lcp), accessed 2026-07-13 America/New_York.
- Tee Time Spot evidence: a production mobile Lighthouse run on `/search` scored 72 performance and 92 accessibility, with a 7.5-second lab LCP, a 428 KiB 2400px CSS background image that was not discoverable in the initial document or high priority, two unnamed compact nav links, and 13 low-contrast text failures between 2.29:1 and 4.1:1. Browser rotation at 320px with forced colors and reduced motion otherwise showed no overflow, small targets, keyboard failure, console error, or failed request.
- Decision: render the decorative hero through Next Image with responsive `sizes`, eager loading, and high fetch priority; preserve the overlay and crop in CSS. Give compact nav links stable accessible names, darken the affected label/support colors above the 4.5:1 AA threshold, and keep the mobile feedback launcher in document flow so it cannot cover the primary Search button. Desktop feedback remains fixed.

## 2026-07-13: Verified simulator identity must override a stale golf-course type

- Sources: [Chicago Golf Authority: How It Works](https://chicagogolfauthority.com/pages/how-it-works) and [Google Places API (New) place types](https://developers.google.com/maps/documentation/places/web-service/place-types), accessed 2026-07-13 America/New_York. The official business page identifies the West Loop address as an indoor simulator facility; Google's current type catalog distinguishes `indoor_golf_course` from `golf_course`.
- Tee Time Spot evidence: a real signed-out `60601` search returned Google place `ChIJy4_CTDEtDogR9wxAr-a-VGI` first and labeled it `Public`, even though it is a suite-based simulator rather than a playable outdoor course. Production still supplies the place through the golf-course query, so type filtering alone does not catch it.
- Decision: exclude this verified non-course by stable Google place ID before accepting type or semantic-public corroboration. Do not add a broad `Authority` or suite-address heuristic; ambiguous generic Chicago course pins remain visible until their identities can be resolved safely.

## 2026-07-13: Sitemaps should cover canonical public routes with trustworthy fields

- Sources: [Google Search Central: Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) (last updated 2025-12-10 UTC) and [Next.js sitemap file convention](https://nextjs.org/docs/app/api-reference/file-conventions/metadata/sitemap) (last updated 2026-03-25), accessed 2026-07-13 America/New_York.
- Finding: sitemaps should list the canonical absolute URLs intended for search results. Google only uses `lastmod` when it consistently reflects a significant page update, and ignores `changefreq` and `priority`; Next.js supports a typed `sitemap.ts` route for programmatic URL generation.
- Tee Time Spot evidence: production `/search` is indexable, has its own canonical URL, and is the primary product workflow, but the live sitemap listed only `/`. The sitemap also generated deployment-time freshness plus `changefreq` and `priority` values that were not backed by page-specific update evidence.
- Decision: list both canonical public routes (`/` and `/search`) and omit guessed or ignored freshness/priority fields. Keep account, email-preview, and signed action routes out because their metadata is explicitly `noindex`.

## 2026-07-13: Invalid locations need descriptive, announced recovery copy

- Sources: [W3C Understanding SC 3.3.1: Error Identification](https://www.w3.org/WAI/WCAG22/Understanding/error-identification) (updated 2026-03-09) and [W3C Understanding SC 4.1.3: Status Messages](https://www.w3.org/WAI/WCAG22/Understanding/status-messages), accessed 2026-07-13 America/New_York.
- Finding: automatically detected input errors should identify the affected input, describe the problem in text, and expose dynamically inserted error messages through an appropriate alert or live-region role.
- Tee Time Spot evidence: a signed-out invalid-location search rendered the raw JSON payload `{"error":"No matching location found."}` on desktop and mobile, and the API classified the correctable input miss as a 502.
- Decision: parse structured API errors into plain recovery copy, mark and associate the location input with the alert, and return 404 for an unmatched location while preserving 502 for genuine provider failures.

## 2026-07-12: Official access evidence must override Places public-query recall

- Source: [Shelter Harbor Golf Club official site](https://www.shgcri.com/) and its [official membership page](https://www.shgcri.com/default.aspx?p=dynamicmodule&pageid=407717&ssid=334819&vnf=1), accessed 2026-07-12 America/New_York. The home page identifies the facility as a member-owned private equity club, and the membership page says membership is by invitation.
- Observed gap: a real signed-out `02891` search returned Shelter Harbor from both Google's golf-course data and the semantic `public golf courses` query, so Tee Time Spot labeled it `Public` despite the official access policy.
- Product decision: stable place-ID exclusions backed by current official access evidence override Google type and text-search corroboration. Name-only `Golf Club` exclusions remain inappropriate because many public facilities use that wording.

## Product Shape

Tee Time Spot should behave like a waitlist assistant rather than a booking marketplace. GolfNow/TeeOff-style products emphasize inventory search, deals, and broad marketplace browsing. Noteefy-style flows emphasize preference capture, waitlist matching, and alerts.

## UX Principles For Automation Cycles

- First screen: make Tee Time Spot, nearby discovery, and alert-only booking clear immediately.
- Course selection: keep the 1 to 5 ranking interaction visible and low-friction.
- Course list: use Google Places photos as a scanning aid when available, keep stable placeholders when not, and show required photo attribution.
- Dashboard: show active searches, ranked courses, probe state, pending matches, and pause/cancel controls.
- Trust: state that users finish booking on the official course site.
- Improvement loop: every automation cycle should inspect onboarding, course ranking, dashboard state, and email copy for friction.
- If the design does not look good in browser screenshots, do a tool research pass and try a better workflow instead of polishing a weak direction.

## Reference Patterns

- Nearby course search: location permission plus typed city/ZIP fallback.
- Waitlist alerts: one user intent, durable preferences, notification when inventory changes.
- Course policy handling: if terms prohibit automated access, skip and record the blocker.

## Current Tool Candidates

Use these as starting points, then refresh before adopting because design tooling changes quickly.

- Figma AI and Figma Make: useful for alternate visual directions, prototypes, annotations, and design iteration.
- v0 by Vercel: useful when the desired output is React/Next.js UI code or a live prototype that can be brought back into the repo.
- Lovable/Replit/Bolt-style app builders: useful for comparing full-app product flows, but generated code must still be reviewed, tested, and adapted to this repo.

## 2026-07-12 Mobile Search Reflow

- Source: [W3C Understanding SC 1.4.10: Reflow](https://www.w3.org/WAI/WCAG21/Understanding/reflow) (accessed 2026-07-12; no page update date shown).
- Finding: ordinary controls and text should remain readable at a 320 CSS-pixel-equivalent width, and stacking sections into one column is a common responsive approach when the layout does not require two dimensions.
- Tee Time Spot evidence: a production check at 375 CSS pixels showed the two-column search grid clipping the location and course-local time values even though the document itself did not overflow horizontally.
- Decision: stack the four primary search fields into full-width mobile rows, keep the desktop grid unchanged, and cover field width plus singular result-count copy in Playwright.
