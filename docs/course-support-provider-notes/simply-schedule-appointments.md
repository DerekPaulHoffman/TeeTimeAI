---
schemaVersion: 1
providerFamily: SIMPLY_SCHEDULE_APPOINTMENTS
registrySupport: NON_SERVER
lastReviewedAt: 2026-11-04
lastVerifiedRelease: null
---

# Provider Family: SIMPLY_SCHEDULE_APPOINTMENTS

## Current Support State

The learned-recipe reader supports the reviewed public client 4.6.12.37 and a published, individually rented simulator with one identical-resource group. The family registry identifies ownership only and does not enable the legacy server dispatcher. Production activation, matching email, and unattended acceptance remain unverified.

## Approaches That Worked

### `public-simulator-availability-get`

- Independently read the canonical official identity/address and its exact public booking link. Re-read the parent iframe and inert anonymous bootstrap on every execution.
- Select one published simulator rental at the requested actual duration, excluding watch parties, drafts, lessons and memberships. Verify its complete resource group and venue timezone. Unknown golfer capacity does not suppress a complete bay rental.
- Check the exact reviewed client bytes before reading the full public availability array. Its timestamps are UTC; each requested interval must fit the venue-local window in full.
- Use the client's public GET resource parameters and a freshly read public nonce. Never call `/async`, select a time, create an appointment, or retain session IDs, nonces or booking tokens in a recipe.
- Implementation: `src/lib/course-discovery/simply-schedule-public.ts` and `simply-schedule-executor.ts`.
- Tests: `src/lib/course-discovery/simply-schedule-public.test.ts`, including serialized replay, duration/resource/source changes, request leases, cancellation and incomplete responses.
- Verified release: `not-production-verified`.
- Exact-runtime outcome: local public development reads only; not original-deadline acceptance.

## Approaches That Failed Or Were Inconclusive

### `generic-rendered-calendar`

The general browser learner reached the public booking page but produced no verified recipe. A later native transport drain failed. Visible calendar times and the failed attempts are retained as evidence; neither is an active saved method or an empty availability result.

## Material Reopen Triggers

Changed client bytes, non-anonymous state, altered service/resource catalog, another timezone, party-only products, missing official identity, and access walls require fresh investigation. A failure never resets the original job deadline.

## Next Novel Action

Verify released unattended learning, two independent replays, backend persistence, normal matching email and restart reuse. A successful local reader does not establish these outcomes.
