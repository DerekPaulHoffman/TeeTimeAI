---
schemaVersion: 1
providerFamily: YOUR_GOLF_BOOKING
mode: SIMULATOR
registrySupport: RUNNABLE
lastReviewedAt: 2026-10-06
lastVerifiedRelease: d5fa0cfa1a25de5256d3afd15ccc8bdec98af1f6
---

# Public simulator calendar support

## Current Support State

The runnable reader is `src/lib/simulators/providers/your-golf-booking.ts`. Its current accepted shape is a published Trackman-hosted simulator configuration, a public simulator bay-time rate, thirty-minute slots, an unrestricted range with verified weekly hours, and the anonymous occupied-bookings feed. Required metadata is the exact venue slug, venue ID, range ID and public option ID. Recognition of the provider alone is insufficient.

## Approaches That Worked

The `published-config-and-occupancy` approach was verified on release d5fa0cfa1a25de5256d3afd15ccc8bdec98af1f6 with three independent fresh `MATCH_FOUND` observations on October 6. The reader derives one-hour intervals from verified resources and hours, subtracts occupied intervals including those that started during the prior twenty-four hours, respects course-local time and refuses unverified restrictions or identity changes. Its focused tests cover empty occupancy, resource restrictions, malformed responses, prior-day overlap and timezone changes.

## Approaches That Failed Or Were Inconclusive

The `homepage-http-only` approach was inconclusive: an official homepage HTTP 403 did not describe the separate public booking calendar. The next different safe step is an owned read of the distinct saved booking page or bounded signed-out rendered official source. Never classify a public rental as inaccessible from the homepage response alone.

## Material Reopen Triggers

Unrecognized configuration, another hosting origin, different slot/horizon settings, private rental options, required perks and restricted resources require fresh owned contract research and meaningful reader tests. Missing metadata or code is an implementation task. Account, CAPTCHA or queue controls require current factual evidence; do not generate or replay their credentials. Occupied-bookings emptiness is not availability proof without public resources, rental rules, opening hours and a complete scoped response.

## Next Novel Action

Use the owned simulator source reader to inspect bounded public rental facts. Its research projection can recognize the published configuration on the vendor's own origin as well as the Trackman host; this does not expand the runtime reader's accepted origins or rental rules. Reuse the runtime reader only when its entire accepted contract fits; otherwise implement reusable support on claimed paths, release it and require two fresh distinct successful deployed checks. A local fixture or Ready deployment alone cannot close an incident.

## Change Log

- 2026-10-06: Recorded verified public configuration/occupancy support and the unsuccessful homepage-only approach. Added a bounded owned research route to learn different public rental contracts while retaining exact-runtime monitoring gates.
