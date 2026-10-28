# Separate public courses at one facility

One discovery/location card may show several independently monitored physical
courses. Each Notify me action starts the normal alert-creation flow for exactly
one canonical Course id. Saved demand, ranks, leases, probes, matches, recipients,
and email outbox semantics remain unchanged. An existing Knolls alert is never
expanded to Glen. The 1–5 course preference and 3 active/paused alert limits remain.

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

Production enablement requires reviewing/applying the two-member plan and deploying
the tested commit. Then verify both card rows, each independent Notify me flow,
and exact-runtime read-only availability for both sheets. Do not create real
customer alerts, send email, mutate customer demand, or restart workers to test it.
