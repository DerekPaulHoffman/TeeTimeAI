# Technical-debt cleanup verification

Date: 2026-07-27

Branch: `chore/reduce-maintenance-risk`

## Scope

- Removed the retired home search component and direct-database QA helpers.
- Replaced the monkey helper's maintained coverage with the existing
  Playwright smoke suite.
- Added Next-aware dead-code and dependency-cycle checks.
- Removed Workflow scheduling cycles through contract and launcher
  boundaries.
- Split discovery transport, course-support selection, email payload
  normalization, and search controls from their large orchestrators.
- Moved editorial, knowledge, pricing, and Leaflet styles from the root
  layout to their owning routes.
- Deferred Clerk's signed-out UI until sign-in is requested. Signed-in
  account controls remain isolated and server-authorized.
- Added aggregate, read-only Postgres relation measurement without adding a
  retention policy or another state store.

## Mobile search performance

The comparison uses the earlier production evidence recorded in
`docs/ux-research-notes.md` and a same-profile mobile Lighthouse run against
the production build from this branch.

| Metric | Before | After |
| --- | ---: | ---: |
| Performance | 83 | 90 |
| Accessibility | 100 | 100 |
| LCP | 4.1 s | 3.6 s |
| Estimated unused JavaScript | 361 KiB | 130 KiB |
| Estimated unused JavaScript reduction | — | 231 KiB |
| Estimated unused CSS | not recorded | 17 KiB |
| Total transferred page weight | not recorded | 448 KiB |
| Network requests | not recorded | 32 |

The 231 KiB reduction exceeds the 150 KiB target. The signed-out browser
trace requested no Clerk resources before account interaction. The page
loaded with HTTP 200, no framework overlay, no page error, and no console
error; the search control and home navigation both rendered and worked.

Evidence is stored outside the repository:

- `search-after.png`
- `lighthouse-search-after.json`

## Postgres boundary

No schema or retention migration is included. Search drafts, traffic
markers, credentials, provider sessions, and request-local caches remain
ephemeral. The aggregate production size snapshot and the unresolved
Workflow dependency advisory are documented in `docs/dependency-risk.md`.
