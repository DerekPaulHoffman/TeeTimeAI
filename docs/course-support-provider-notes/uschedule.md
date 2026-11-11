---
schemaVersion: 1
mode: SIMULATOR
providerFamily: USCHEDULE
registrySupport: RUNNABLE
lastReviewedAt: 2026-11-11
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

### `selected-sim-booking-hour`

- A selected Sim Booking may coexist with unrelated member products. Require
  a visible corroborating simulator-play description, unique bounded service
  identifiers, an explicit selected 60-minute duration and matching priced rows.
- Reject location, resource and quantity selectors in this default pooled
  profile. Preserve unknown capacity, anonymous date/cursor reads and complete
  ordered-list requirements; the other catalog entries grant no eligibility.
- Implementation: `src/lib/simulators/providers/uschedule.ts`.
- Tests: `src/lib/simulators/providers/uschedule-sim-booking.test.ts` covers
  open-day intervals, later-day completion, occupied-bay rejection, source drift,
  member/access rejection and projection privacy.
- Proof level: local tests. Exact-runtime monitoring remains unverified until
  fresh owned configuration, release proof and two deployed checks succeed.

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

### `other-label-without-syntax`

- The closed `OTHER` label kind alone cannot distinguish a suffixed simulator
  rental from another service. An optional closed label-shape diagnostic now
  separates those forms without retaining the suffix or other source text.
- This describes syntax only. It does not establish venue identity, rental
  linkage, public access, capacity or availability. Existing rental rejection
  remains unchanged and legacy absent label shapes remain unknown.
- Implementation: `src/lib/simulators/providers/uschedule.ts` and
  `src/lib/automation/simulator-support-research-policy.ts`.
- Regression, persistence and privacy checks:
  `src/lib/automation/simulator-support-research.test.ts`.
- Proof level: local tests only. Next action: register the exact release and
  obtain a fresh guide-authorized observation before choosing reader support.

### `resource-counts-without-catalog-shape`

- A selected pool and numeric resource counts do not establish whether every
  option is inert, visible, uniquely identified or directly in the selector.
- The rental diagnostic now reports a closed catalog-shape state. It inspects
  every option and ancestor and rejects raw values from the persisted schema.
  Old missing states remain unknown. Static unique options do not establish
  rental linkage, public eligibility, capacity or full-session availability.
- Implementation: `src/lib/simulators/providers/uschedule.ts` and
  `src/lib/automation/simulator-support-research-policy.ts`.
- Regression/privacy/rejection checks:
  `src/lib/automation/simulator-support-research.test.ts`.
- Proof level: local tests only. The existing rental rejection is unchanged.
- Next action: use only a fresh guide-authorized source observation to read the
  diagnostic, then separately establish resource semantics before reader work.

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

## Next Novel Action

Register and verify the exact reader release, then follow only a newly eligible
owned booking read to obtain current validated configuration. Stop when source
authority, the research budget or the deployment proof does not permit it;
preserve an unresolved incident rather than infer rental identifiers.

## Change Log

- 2026-11-11: Distinguished rejected rental-label syntax without retaining
  labels or changing acceptance, source access or monitoring proof.

- 2026-11-10: Distinguished complete inert resource catalogs from unsafe,
  malformed and duplicate options without relaxing rental acceptance.

- 2026-11-10: Added a strict selected Sim Booking profile with independently
  corroborated simulator description; unrelated member catalog entries do not
  determine the selected rental's access.
- 2026-11-04: Added strict default hourly rental support without widening the
  supported duration, capacity, transaction or source-research boundaries.
