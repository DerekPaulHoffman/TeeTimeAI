---
schemaVersion: 1
providerFamily: TEESHEET
mode: SIMULATOR
registrySupport: RUNNABLE
lastReviewedAt: 2026-10-12
lastVerifiedRelease: null
---

# TeeSheet public simulator calendar

## Current Support State

src/lib/simulators/providers/teesheet.ts reads unsigned date-specific availability.
Required metadata is a reviewed tenant matching the supported booking-root shape,
verified durations and capacity. The provider supplies explicit bay identity,
local intervals and occupied status. Request-mode inventory is provisional.
Current proof: focused tests and live public diagnostics; production unverified.

## Approaches That Worked

Strategy public-explicit-bay-intervals: actual unsigned reads returned a complete
closed day and available intervals on an open control day. Validate date,
duration, bay identity, occupied flags, interval length and duplicate slots.
Focused tests: src/lib/simulators/providers/teesheet.test.ts.
Verified release: not-production-verified. Exact-runtime outcome: not-proven.

## Approaches That Failed Or Were Inconclusive

Strategy clock-dependent-cta-retention: collector time slightly ahead of database
time discarded official booking roles. Settlement now uses database time and
retains raw collector time separately. A fresh supported root handoff still
requires exact official source/access/role lineage and bounded requests.

Strategy loading-state-emptiness: transient fully-booked text preceded actual
available inventory. Use settled explicit responses and corroborating UI.

## Material Reopen Triggers

Changed responses, tenant identity, session settings, provisional mode or access
requirements need fresh evidence and focused tests. Elapsed time does not repair
an implementation defect.

## Next Novel Action

Configure reviewed facts, deploy the exact release, then obtain two fresh normal
checks and durable closeout. No booking, waitlist, contact or account operation.

## Change Log

- 2026-10-12: Added explicit intervals and closed-day controls; recorded clock/CTA
  and loading-shell failures without asserting deployed monitoring.
