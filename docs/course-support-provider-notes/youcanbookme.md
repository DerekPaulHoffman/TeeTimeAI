---
schemaVersion: 1
providerFamily: YOUCANBOOKME
registrySupport: NON_SERVER
lastReviewedAt: 2026-11-04
lastVerifiedRelease: null
---

# Provider Family: YOUCANBOOKME

## Current Support State

- The learned-recipe executor supports one reviewed v1 public default-rental protocol. This does not add a general legacy server adapter or enable rollout.
- Requires a canonical official root and complete address, a static room/duration directory, and anonymous provider roots for every room at the selected published duration.
- The reader uses GET only. It does not use cookies, account sessions, form selections, slot selections, reservations, or POST requests. Server-created anonymous browsing IDs stay in memory and are never recipe fields.
- Unsupported: v2 contexts, preview pages, challenges, selectable appointment types/team members, multiple or remote locations, missing rooms, changed client bytes, and other directory layouts.
- Current proof level: focused tests and independent local public execution. Production email delivery and unattended discovery are not established by this note.

## Approaches That Worked

### `anonymous-default-rental-get`

- A fresh public document supplies the default rental and its unselected anonymous context as closed JSON assignments.
- The exact reviewed public client reads a dated availability key and then one complete slot array. Millisecond timestamps, venue timezone, full published duration, and remaining bay units are checked independently.
- All rooms in the official directory must verify. A failed room produces an incomplete check, never an empty or partially complete result.
- Saved metadata contains public room/profile identifiers, catalog and configuration hashes, official links, and actual duration. Every execution checks them again with new anonymous contexts.
- `ANY` may choose the common published duration before two independent replays; an exact-duration alert cannot inherit this choice.
- Implementation: `src/lib/course-discovery/youcanbook-public.ts`, `youcanbook-executor.ts`, and the existing adapter/recipe pipeline.
- Tests: corresponding public/parser and executor tests, recipe validation, request-family serialization, and Stagehand worker verification.
- Verified release: `not-production-verified`.
- Exact-runtime outcome: not yet established.

## Approaches That Failed

### `generic-dom-with-opaque-date-response`

- Generic browser extraction cannot treat an opaque response URL or visible times as date/completeness proof. Request failures and token limits remain failures.
- A public server-provided browsing context is distinct from a customer account, but must be implemented as the reviewed protocol rather than a generic authorization/header exception.

## Safe Reopen Triggers

- A changed published client requires protocol review and regression evidence before a new hash is supported.
- A changed official room/duration catalog or location requires a new independently verified method.
- HTTP throttling or temporary server failure may use the existing bounded retry policy; it does not reset an original deadline.

## Next Novel Action

Verify normal unattended source discovery, backend activation, matching application email, and restart reuse on the released code. Local methods alone do not satisfy those gates.
