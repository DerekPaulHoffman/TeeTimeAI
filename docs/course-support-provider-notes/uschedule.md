---
schemaVersion: 1
mode: SIMULATOR
providerFamily: USCHEDULE
registrySupport: RUNNABLE
lastReviewedAt: 2026-11-04
lastVerifiedRelease: null
---

# Provider Family: USCHEDULE

## Current Support State

The default pooled reader requires an exact reviewed tenant and service, public
access, unknown capacity and only the selected 60-minute duration. Anonymous
date/list reads retain the existing access, session, pagination and ordering
guards. Additional quantity, resource and location selectors require separately
reviewed support. Projection is configuration evidence, never monitoring proof.

## Approaches That Worked

### `default-hourly-rental`

- Recognize the exact public hourly rental label alongside the existing default
  simulator rental label. Preserve the single selected service, one-hour default,
  bounded duration catalog and pooled resource checks.
- The hourly profile additionally requires matching rental labels on every row
  and rejects unverified group, location and resource selectors.
- Implementation: `src/lib/simulators/providers/uschedule.ts`.
- Tests: `src/lib/simulators/providers/uschedule-hourly-rental.test.ts` covers
  open-day intervals, a later-day no-match witness, assigned-bay rejection,
  duration/access drift and projection privacy.
- Proof level: local tests. Verified release: `not-production-verified`.
- Exact-runtime outcome: `not-proven`.

## Approaches That Failed Or Were Inconclusive

### `literal-default-label-only`

- Normalized failure class: `INVALID_SOURCE`.
- A public hourly catalog was rejected solely because its label differed from
  the older reference catalog. That literal label is not a provider-wide rule.
- A visible calendar with blocked secondary requests remains incomplete. Public
  starts and an optional login link establish neither an access restriction nor
  complete monitoring.
- Next action: exact-release deployment, then only a current guide-authorized
  source read and reviewed configuration. Do not repeat a spent route or infer
  missing service/resource facts from a screenshot.

## Material Reopen Triggers

- A relevant reader release and a newly eligible owned source read.
- Fresh validated rental configuration or materially changed official evidence.
- Two independent successful deployed observations for an adopted source are
  still required before claiming monitoring recovery.

## Change Log

- 2026-11-04: Added strict default hourly rental support without widening the
  supported duration, capacity, transaction or source-research boundaries.
