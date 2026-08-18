# Course-Support Provider Notes

This directory is the privacy-safe, version-controlled engineering memory for reusable provider work. It helps a responder avoid repeating an approach that already failed and reuse an approach that produced trustworthy monitoring.

It is not the operational source of truth. Live decisions come from Postgres: the current `CourseSupportIncident`, its versioned attempt ledger, append-only monitoring events, current provider evidence, batch ownership/proof, and the newest exact-runtime course observation. A note may be stale, and it never makes a provider runnable or a course monitored by itself.

## Read And Update Scope

After a responder claims one provider-family/failure-fingerprint group:

1. Read this README.
2. Read only `<provider-family>.md` for the selected normalized family when it exists.
3. Do not scan the other family notes or `learning-log.md` during a routine batch.
4. Create or update only the selected family note when the batch produces reusable knowledge: a new adapter/parser contract, a worked approach, a disproved approach, changed required metadata, or a material reopen trigger.
5. Do not update Markdown for an ordinary transient retry or an unchanged per-course observation.

Use lowercase kebab-case filenames derived from an actual normalized registry family, such as `foreup.md` or `golf-with-access.md`. Copy `_template.md` when a registry family receives its first reusable note. Do not create a generic source-missing or discovery note: wait until evidence identifies a registry family, then record only reusable family-specific learning. Claim the note path before editing it and verify it with the same implementation batch.

## Required Content

Every family note must contain:

- Structured front matter with schema version, normalized provider family, registry support state, and last review date.
- Current support state and the metadata/capability conditions required for that state.
- A stable approach key for each reusable attempt.
- Approaches that worked, including proof level, exact repository implementation/test paths, and the deployed release when production proof exists.
- Approaches that failed or were inconclusive, including the normalized failure class, why they did not establish monitoring, and an explicit material condition required before reuse.
- Material reopen triggers and the next genuinely different safe action.
- A short change log that says what assumption changed.

Use repository paths, test names, normalized provider families/failure classes, coarse safe outcomes, dates, and full Git release SHAs. Do not claim production success from local tests, a Ready deployment, or an unchanged-runtime verification; only exact-runtime `MATCH_FOUND`, `NO_MATCH`, or `BOOKING_NOT_OPEN` evidence can support that claim.

## Privacy And Safety

Never include:

- Course or customer names.
- Email addresses, recipients, or signed links.
- Official, booking, API, or evidence URLs, including URL roots.
- Database, search, incident, batch, task, workflow, reader-job, or provider record identifiers.
- Tokens, cookies, sessions, request headers, credentials, or environment values.
- Raw provider payloads, copied HTML, or raw error messages.
- Checkout, account, CAPTCHA, verification-code, queue bypass, booking, payment, or transaction instructions.

Provider-family names, normalized failure classes, repository paths, test names, safe strategy keys, and Git release SHAs are permitted. Keep explanations reusable and aggregate; do not encode a course identity into an approach key or note title.

## Retry Novelty Rule

A retry is allowed only when it can produce information or behavior that the prior attempt could not. The reusable material inputs are:

- Selected strategy and ordered playbook stage.
- Normalized provider family and failure class.
- Exact application runtime/release.
- Material provider configuration snapshot.
- Compatible reader capability and build, when applicable.
- Current official evidence.

Repeating the same approach with the same material inputs is not a new attempt. Choose the next safe stage or implementation, wait for a persisted material change, or use the bounded human-review/final endpoint. Elapsed time alone is a reopen trigger only for a persisted retry of a true transient failure: `RATE_LIMIT`, `HTTP_5XX`, `TIMEOUT`, or `NETWORK`.

The note explains this rule to future agents; the database attempt signature and lifecycle state must enforce it in code.
