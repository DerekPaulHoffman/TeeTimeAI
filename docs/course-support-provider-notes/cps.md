---
schemaVersion: 1
providerFamily: CPS
registrySupport: RUNNABLE
lastReviewedAt: 2026-11-19
lastVerifiedRelease: null
---

# Provider Family: CPS

## Current Support State

- Registry support is conditional on verified official public source, current build and tenant configuration, exact venue/contact binding and a complete public response.
- Named sheets require a unique complete correspondence with the official named layouts. A trailing numeric round label is removable only when it equals the validated provider row's round length and the remaining whole name equals an official name.
- Sold round length never proves physical course layout.
- Safe boundary: public signed-out browsing only, with existing URL, access, cancellation and request-budget fences.
- Proof level: deployed diagnostics and local regression tests. Exact-runtime monitoring remains unproven for the retained failure.

## Approaches That Worked

### `bind-validated-numbered-sheet-labels`

- Result: local name-binding regressions and deployed learner progression beyond name comparison.
- Implementation: `src/lib/course-discovery/cps-official-course-catalog.ts`.
- Tests: `src/lib/course-discovery/cps-official-course-catalog.test.ts`, `src/lib/course-discovery/cps-executor.test.ts`.
- Deployed release: `610ad709b3698074594f27065828f59b345a95ab`.
- Exact-runtime monitoring outcome: not-proven. Progression into availability replay is not monitoring success.

## Approaches That Failed Or Were Inconclusive

### `require-array-content-without-structural-evidence`

- Normalized failure class: `MISSING_METADATA`.
- Result: inconclusive. A successful matching transaction envelope had object content where the parser required an array.
- Deployed diagnostic release: `139ba3d6ffd1dc4cdf5c59b6a2645ef3ca06dc6c`.
- Implementation/tests: `src/lib/course-discovery/cps-availability-diagnostic.ts` and its test file, `src/lib/course-discovery/cps-executor.ts`.
- The object type alone supplies no field mapping, completeness, empty inventory or access verdict. The raw response was not retained.
- Do not repeat that exhausted learner or unwrap an arbitrary object. Require bounded private structure from a materially corrected runtime and independent execution before changing response mapping.

## Material Reopen Triggers

- A deployed implementation changes the missing structural diagnostic capability.
- New owner-bound structural evidence supports a focused offline parser regression.
- A later corrected parser passes independent real execution with changed parameters.
- Time alone is not a trigger for another discovery attempt.

## Next Novel Action

- Preserve bounded structure on the original failed attempt without scalar values; disclose it only through the current reciprocal owner/source/runtime context.
- Paths: `src/lib/course-discovery/cps-availability-structure.ts`, `src/lib/course-discovery/engineering-repair.ts`, `src/lib/automation/course-support-research-context.ts`, and the normal worker/failure checkpoint modules.
- Stop on source, ownership, lease, access or protected-operation failure. Structural evidence grants no provider access or activation authority.

## Change Log

- 2026-11-19: Distinguished conditional sheet-label binding from incomplete availability replay; recorded the missing object-structure evidence and retained all parser rejection gates.
- 2026-11-19: Private structural capture on deployed release `cd4a6c68a1902c5c7fb6782ffe638f3f9d1ed238` identified a five-field message object, not wrapped inventory. Values remain uncaptured. The established production adapter already recognizes one exact canonical empty message; the learner now reuses that unchanged recognizer with stricter literal transaction binding. Unknown messages and altered, incomplete or contradictory envelopes remain rejected. Tests cover all five message fields and normal executor request counts. Local proof only; fresh independent execution is still required to establish whether the actual message matches that known contract.
