# Separate public courses at one facility

One discovery/location card may show several independently monitored physical
courses. Each Notify me action starts the normal alert-creation flow for exactly
one canonical Course id. Saved demand, ranks, leases, probes, matches, recipients,
and email outbox semantics remain unchanged. An existing Knolls alert is never
expanded to Glen. The 1–5 course preference and 5 active/paused alert limits remain.

The root keeps its Google Place identity and existing Course id. A second physical
course uses its own reusable Course id with no duplicate Google Place id. The
typed `bookingMetadata.sharedFacility` manifest names the root and all member
Course ids; every member must agree before the UI presents the group. This is
durable provider knowledge in the existing Neon model, not a runtime name registry
or inferred whole-facility coverage. No schema migration is required.

Ordinary ForeUP reads prefer a unique exact sheet title over a shared facility
`course_name`, then verify the exact facility/sheet/active visible Public class.
The ordinary check proves only that named course. Managed access recipes still
require their existing complete-inventory checks; those gates are unchanged.

## Operator preparation

Normal operation detects groups automatically. Each ordinary ForeUP read reuses
its fresh public catalog to identify distinct named physical courses sharing the
exact facility and owner. Only an unambiguous visible active Public class qualifies;
member categories, rates, practice facilities and round products are excluded.
The catalog does not establish physical hole counts. Existing verified layout
evidence is preserved; new courses show an unverified layout until separately proven.

Official-site discovery also recognizes provider-independent schema.org
`containsPlace` lists of distinct `GolfCourse` entries with explicit co-located
coordinates and official page URLs. The existing course must match one member.
Such children retain pending public access and unknown monitoring until their own
normal first-check verification; Notify me can save that pending demand. A chain
directory, shared hostname, or nearby location alone never establishes membership.
Ambiguous pages remain ordinary discovery work rather than guessed course records.

The automatic path saves reusable Course knowledge transactionally, reuses exact
existing siblings, and returns the group to the current search card immediately.
Repeated/concurrent checks are idempotent. It never adds courses to an existing
alert, copies recipients, starts a workflow, activates a recipe, or sends email.
New physical courses have independent monitoring and do not inherit rates, layouts,
booking windows or successful-check claims. Removed automatic membership does not
delete courses or demand; manual membership is never silently reduced.

The explicit operator below remains an optional repair tool, not a required setup
step for detected facilities. Automatic detection runs only on fresh fixed-parser
observations from normal signed-out checks/discovery, not model-submitted manifests.

`npx tsx scripts/automation/manage-shared-public-courses.ts --plan <file.json>`
prepares a dry run against the configured database, verifies every exact public
sheet/class with fresh signed-out HTML, and reports the target database host and
proposed records. Provider requests retain the shared family lease. It creates
no alerts, sends no messages, starts no learners, and never visits checkout.

Applying is a separate operation requiring explicit target confirmation:
`--apply --expected-database-host <reviewed-host>`. Inspect the dry run first.
The transaction preserves the root identity and metadata (adding only the group
manifest), checks concurrent root metadata changes, and uses deterministic member
ids to prevent duplicate courses. It reads back all members after applying.
Do not apply to Production or deploy as part of local implementation approval.

Example plan shape:

```json
{
  "rootCourseId": "<existing-course-id>",
  "courses": [
    { "existingCourseId": "<existing-course-id>", "name": "<exact-primary-course-name>", "scheduleId": 123, "bookingClassId": 456, "layoutHoles": 18, "layoutEvidenceUrl": "https://official.example/primary-course" },
    { "name": "<exact-second-course-name>", "scheduleId": 124, "bookingClassId": 457, "layoutHoles": 9, "layoutEvidenceUrl": "https://official.example/second-course" }
  ]
}
```

Physical layouts must be verified from official course documentation before
preparing a plan. Tee-sheet round products are never physical-layout evidence.
Prices and round lengths shown on the cards come from that course's own observed
slots. Unknown prices stay unknown, and a failed/unfinished check is never shown
as an empty sheet. Completed saved alerts show stopped checks, not a fresh check.

## Tashua evidence and release preparation

The official [Knolls course page](https://www.tashuaknolls.com/golf-course/tashua-knolls-course/)
documents 18 physical holes. The official [Glen course page](https://www.tashuaknolls.com/golf-course/tashua-glen-course/)
documents a distinct nine-hole course. The [FAQ](https://www.tashuaknolls.com/golf-course/faqs/)
also distinguishes physical layouts from 9-/18-hole rounds on Knolls.
The observed signed-out ForeUP facility 21017 has Knolls sheet 6654/class 14910
and Glen sheet 6463/class 14911, both labelled Online Tee Times and both carrying
the Knolls `course_name`. Those exact shapes are regression fixtures, not runtime
hardcoded exceptions. Re-read the public catalog before applying the operator plan.

Production enablement requires deploying the tested commit. Normal course checks
then detect and persist verified membership automatically; no per-facility plan is
required. The reviewed operator plan remains available for deliberate repair.
Verify both card rows, each independent Notify me flow,
and exact-runtime read-only availability for both sheets. Do not create real
customer alerts, send email, mutate customer demand, or restart workers to test it.
