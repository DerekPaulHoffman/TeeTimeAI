---
schemaVersion: 1
providerFamily: MEMBERSPORTS
registrySupport: NON_SERVER
lastReviewedAt: 2026-08-28
lastVerifiedRelease: null
---

# Provider Family: MEMBERSPORTS

## Current Support State

- Registry behavior: Recognized as a non-runnable provider family so an exact official booking link is retained instead of being mislabeled as source missing.
- Required metadata or reader capability: Server dispatch remains disabled. The local reader requires `MEMBERSPORTS_RENDERED` parser version 1 and an exact positive club/course route identity with bounded numeric view-state segments.
- Safe signed-out read boundary: Public tee-time landing and availability observation only; never authenticate, reserve, hold, purchase, or enter checkout.
- Known unsupported shapes: Account, profile, payment, checkout, administrative, malformed, ambiguous multi-course, and non-tee-time routes.
- Current proof level: signed-out rendered observation plus local tests; production exact-runtime proof remains pending

### `exact-course-rendered-reader-v1`

- Applies to: An exact official MemberSports course route with public signed-out availability cards.
- Result: The reader filters cards to the exact normalized course name, requested player count, and displayed local date while rejecting sibling routes, transaction routes, challenges, and changed card shapes.
- Why it worked: The route binds positive club/course identifiers and the rendered page exposes stable time, course, capacity, and price fields before any tee-time selection.
- Implementation paths: `src/lib/local-reader/course-key.ts`, `src/lib/local-reader/capabilities.ts`, `tools/local-chrome-reader/membersports-reader.js`, `tools/local-chrome-reader/background.js`, `tools/local-chrome-reader/content.js`, and `tools/local-chrome-reader/manifest.json`.
- Focused tests: `src/lib/local-reader/local-reader.test.ts` and `src/lib/local-reader/capabilities.test.ts`.
- Verified release: `not-production-verified`
- Exact-runtime outcome: `not-proven`
- Observed at: 2026-08-28

## Approaches That Worked

### `official-course-cta-provider-identity-v1`

- Applies to: A canonical official course page with one exact, safe MEMBERSPORTS tee-time CTA.
- Result: The provider family and booking destination remain current course knowledge while monitoring correctly stays non-runnable.
- Why it worked: Evidence retention is separated from server-adapter readiness, and the landing identity is scoped by the provider's club and course route identifiers.
- Implementation paths: `src/lib/automation/provider-capabilities.ts`, `src/lib/automation/browser-discovery.ts`, and `src/lib/automation/db-service.ts`.
- Focused tests: `src/lib/automation/provider-capabilities.test.ts`, `src/lib/automation/browser-discovery.test.ts`, and `src/lib/automation/browser-discovery-db.test.ts`.
- Verified release: `not-production-verified`
- Exact-runtime outcome: `not-proven`
- Observed at: 2026-08-20

## Approaches That Failed Or Were Inconclusive

### `unknown-host-inspected-only-v1`

- Applies to: An exact official booking CTA whose provider hostname was not in the capability registry.
- Normalized failure class: `UNSUPPORTED_FAMILY`
- Result: failed
- Why it did not establish monitoring: Discovery retained the link in append-only history, but the promotion boundary rejected the unknown provider identity and left the mutable course projection as source missing.
- Runtime/proof level: deployed discovery evidence without server-adapter proof
- Do not retry until: Provider recognition or the trusted non-runnable official-CTA promotion contract changes materially.
- Next different safe action: Retain the corroborated destination as non-runnable provider evidence, then implement and verify a public signed-out reader separately.
- Observed at: 2026-08-20

## Material Reopen Triggers

- [ ] Exact deployed release adds or changes the relevant MEMBERSPORTS implementation.
- [ ] Material provider route, public access, or official course evidence changes.
- [ ] Failure family/class changes.
- [ ] A compatible reader capability/build becomes available.

## Next Novel Action

- Action: Implement a bounded server adapter only after public course identity, availability response, URL safety, and failure behavior are captured in reusable tests.
- Expected new information or behavior: Signed-out availability can produce `MATCH_FOUND`, `NO_MATCH`, or `BOOKING_NOT_OPEN` without entering any transaction or account flow.
- Owned paths/tests: Add a dedicated adapter and its provider-capability, workflow, and safe-URL tests.
- Stop condition: Stop at the first account, challenge, ambiguous course identity, unsafe URL, schema conflict, or transaction boundary.

## Change Log

- 2026-08-28: Added the first fail-closed rendered reader contract; exact-runtime production proof remains required.
- 2026-08-20: Registered the family as non-runnable and separated official booking-link retention from adapter readiness.
