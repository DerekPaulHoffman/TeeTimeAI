# UX Research Notes

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
