# UX Research Notes

## Product Shape

TeeTimeAI should behave like a waitlist assistant rather than a booking marketplace. GolfNow/TeeOff-style products emphasize inventory search, deals, and broad marketplace browsing. Noteefy-style flows emphasize preference capture, waitlist matching, and alerts.

## UX Principles For Automation Cycles

- First screen: make TeeTimeAI, nearby discovery, and alert-only booking clear immediately.
- Course selection: keep the 1 to 5 ranking interaction visible and low-friction.
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
