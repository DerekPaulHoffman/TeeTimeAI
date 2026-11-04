---
schemaVersion: 1
providerFamily: CHRONOGOLF
registrySupport: RUNNABLE
lastReviewedAt: 2026-11-04
lastVerifiedRelease: null
---

# Provider Family: CHRONOGOLF

## Current Support State

The existing public adapter and learned recipes retain their complete public profile, catalog, reviewed-client and pagination checks. The new postal-conflict path has local live-reader evidence; production learning and email acceptance for that path remain unverified.

## Approaches That Worked

### `fresh-official-postal-conflict`

- Only an otherwise exact single-course public profile with a four-digit ZIP, a canonical US ZIP beginning with zero, and the independently supplied exact public phone may request this extra identity read.
- A fresh, privately attested native official root must corroborate its exact title, complete canonical physical address, public phone and direct profile link. A whole footer address may append only the matching phone and official website.
- An exact public “Play Golf” profile anchor is accepted within this proof. It does not broaden generic navigation, member/event links or the delegated booking scanner.
- A copied page, wrong street/locality/state/phone/host, five-digit conflicting ZIP, expired witness or missing raw/rendered edge remains a failure. No ZIP is guessed from the profile.
- Every replay re-earns the root proof; canonical identity and public-phone hashes participate in the immutable catalog hash.
- Tests: `chronogolf-source.test.ts` and `chronogolf-executor.test.ts`.
- Verified release: `not-production-verified`.
- Exact-runtime outcome: local public inspection and matching execution only; no original-deadline acceptance.

## Approaches That Failed Or Were Inconclusive

### `repeat-identity-rejection`

Repeating the same rejected profile does not repair its postal typo. The fixed inspector now permits a fresh Sol investigation after an identity rejection, constrained to independently verified typed adapters. It cannot evade identity checks through generic DOM or JSON extraction.

## Material Reopen Triggers

Changed client bytes, public catalog, canonical identity, phone, physical source, or booking access require fresh evidence. Preserve failed jobs and their original deadlines.

## Next Novel Action

Verify deployed normal learning, persisted methods, matching application email and restart reuse. Local reader success does not satisfy those gates.
