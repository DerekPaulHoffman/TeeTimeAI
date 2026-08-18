---
schemaVersion: 1
providerFamily: REPLACE_WITH_NORMALIZED_FAMILY
registrySupport: RUNNABLE | NON_SERVER
lastReviewedAt: YYYY-MM-DD
lastVerifiedRelease: null
---

# Provider Family: REPLACE_WITH_NORMALIZED_FAMILY

## Current Support State

- Registry behavior:
- Required metadata or reader capability:
- Safe signed-out read boundary:
- Known unsupported shapes:
- Current proof level: source only | local tests | deployed runtime | exact-runtime monitoring

## Approaches That Worked

### `stable-approach-key`

- Applies to:
- Result:
- Why it worked:
- Implementation paths:
- Focused tests:
- Verified release: full Git SHA or `not-production-verified`
- Exact-runtime outcome: `MATCH_FOUND`, `NO_MATCH`, `BOOKING_NOT_OPEN`, or `not-proven`
- Observed at:

## Approaches That Failed Or Were Inconclusive

### `stable-approach-key`

- Applies to:
- Normalized failure class:
- Result: failed | inconclusive
- Why it did not establish monitoring:
- Runtime/proof level:
- Do not retry until:
- Next different safe action:
- Observed at:

## Material Reopen Triggers

- [ ] Exact deployed release changes the relevant implementation.
- [ ] Material provider configuration or official evidence changes.
- [ ] Failure family/class changes.
- [ ] A compatible reader capability/build becomes available.
- [ ] A persisted `Retry-After` or bounded retry schedule matures for a true transient failure.

Remove triggers that do not apply and add the precise safe trigger for every failed approach. Time alone is not a trigger for discovery or implementation-required work.

## Next Novel Action

- Action:
- Expected new information or behavior:
- Owned paths/tests:
- Stop condition:

## Change Log

- YYYY-MM-DD: Describe the reusable assumption, implementation, or proof that changed.

Before committing, remove every placeholder and confirm the note contains no course/customer names, URLs, identifiers, provider payloads, raw errors, credentials, sessions, or transaction instructions.
