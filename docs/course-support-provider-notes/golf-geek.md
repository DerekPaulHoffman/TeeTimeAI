---
schemaVersion: 1
providerFamily: GOLF_GEEK
registrySupport: RUNNABLE
lastReviewedAt: 2026-09-23
lastVerifiedRelease: null
---

# Provider Family: GOLF_GEEK

## Current Support State

- Registry behavior: runnable only after the official course site links to a matching booking subdomain and the provider's public course profile confirms the course name, town, state, official site, and booking origin.
- Required metadata or reader capability: a validated provider course identifier, clean booking origin, official site, and optional booking-window days.
- Safe signed-out read boundary: booking root, its first-party application script, public course profile, and dated tee-time feed. The reader selects the public rate and constructs an official link without requesting its booking details page.
- Known unsupported shapes: a different booking host, conflicting course identity, missing public rate, authenticated or challenged feed, or changed provider API shape.
- Current proof level: live signed-out read and local tests; deployed-runtime monitoring remains pending.

## Approaches That Worked

### `official-page-and-public-profile`

- Applies to: official sites that link to their own Golf Geek booking subdomain.
- Result: course-bound provider metadata and public tee times can be read without a sign-in or transaction.
- Why it worked: the application script supplies a single course identifier, and the public course profile independently confirms the saved identity and booking origin.
- Implementation paths: `src/lib/automation/golf-geek-discovery.ts`, `src/lib/adapters/golf-geek.ts`, provider dispatch and capability registry.
- Focused tests: `golf-geek-discovery.test.ts`, `golf-geek.test.ts`, provider capability and monitoring-discovery suites.
- Verified release: `not-production-verified`
- Exact-runtime outcome: `not-proven`
- Observed at: 2026-09-23

## Approaches That Failed Or Were Inconclusive

### `generic-official-site-inspection`

- Applies to: a newly identified official course site with a booking link from an unrecognized provider.
- Normalized failure class: MISSING_METADATA
- Result: inconclusive
- Why it did not establish monitoring: the generic discovery path had no validated provider profile or tee-time reader.
- Runtime/proof level: prior deployed runtime.
- Do not retry until: a release includes the reusable Golf Geek discovery and reader.
- Next different safe action: verify the new runtime through the owned course-support workflow and inspect a fresh provider probe.
- Observed at: 2026-09-23

## Material Reopen Triggers

- [ ] The exact deployed release changes the discovery or reader.
- [ ] The provider changes the public course profile, booking origin, or tee-time schema.
- [ ] A fresh signed-out read returns an identity conflict, access barrier, or different failure class.

## Next Novel Action

- Action: verify a fresh course-support check on the deployed release.
- Expected new information or behavior: persisted runnable metadata, a current provider probe, and incident closeout only after monitoring evidence.
- Owned paths/tests: Golf Geek discovery, adapter, and monitoring-discovery tests.
- Stop condition: identity conflict, access barrier, or inability to prove the runtime and provider observation belong to the same release.

## Change Log

- 2026-09-23: Added the reusable signed-out discovery and tee-time reader after public profile corroboration.
