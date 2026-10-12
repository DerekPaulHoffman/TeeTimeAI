---
schemaVersion: 1
providerFamily: UPPER_HAND
mode: SIMULATOR
registrySupport: RUNNABLE
lastReviewedAt: 2026-10-12
lastVerifiedRelease: null
---

# Upper Hand public simulator calendar

## Current Support State

src/lib/simulators/providers/upper-hand.ts reads public rental configuration,
then date-specific resource inventory. Metadata requires reviewed tenant, rental
and resource identities. Support is limited to active public open-booking rentals
without membership gates, using one selected bay and no required staff.
Current proof: focused tests and live public diagnostics; production unverified.

## Approaches That Worked

Strategy public-date-resource-intervals: the public rental detail exposes a
credential-free date-specific reader. Validate identity, duration and resources
before consuming intervals. Date rows may contain available bays when the
top-level remaining count is zero.
Focused tests: src/lib/simulators/providers/upper-hand.test.ts.
Verified release: not-production-verified. Exact-runtime outcome: not-proven.

## Approaches That Failed Or Were Inconclusive

Strategy purchase-gate-as-monitoring-gate: the purchase drawer requires an account,
but the separate public detail and availability do not. Purchase copy alone
cannot establish a monitoring restriction.

Strategy undated-empty-aggregate: an undated empty response did not describe the
requested day. Use the application-confirmed date parameter and validated rows.
Schedule max_size describes reservation units, not golfer capacity; preserve
unknown capacity unless independent official evidence establishes it.

## Material Reopen Triggers

Changed identities, private or membership-gated products, mixed staff/resource
schedules, invalid intervals or access requirements need fresh source research.
Missing facts cannot be invented from a similar rental.

## Next Novel Action

Configure reviewed facts and obtain two fresh exact-release normal checks.
Never use purchase, scheduling, payment or account operations. Reject ambiguous
inventory and retain failed observations for diagnosis.

## Change Log

- 2026-10-12: Added explicit resource support; recorded purchase-gate, undated
  aggregate and reservation-capacity mistakes with their different safe actions.
