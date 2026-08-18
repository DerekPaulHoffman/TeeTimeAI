# Course-Support Process Learning Log

This file records generic process lessons only. It is not a provider-family note and scheduled responders must not read it during routine claimed work. Live incident and monitoring state remains in Postgres.

## 2026-08-18 - Stop Unchanged Repair Retries

### Observed Pattern

The investigation backlog could grow while responders remained active because a closed batch did not necessarily represent a repair. Some implementation-required failure classes could follow the same time-based retry path as transient provider outages, and an evidence-only verification of the unchanged runtime could close as another scheduled retry. That created activity without new provider support, new evidence, or a truthful endpoint.

### What Helped

- Durable incidents and provider-family/failure grouping prevented duplicate per-check incidents and exposed reusable provider leverage.
- The ordered attempt ledger preserved the current stage, result, runtime, and proof boundary.
- The monitoring strategy already distinguished transient provider failures from discovery and adapter-repair work.
- Exact-runtime verification correctly remained the only proof of restored monitoring.

### What Did Not Work

- Treating missing source, missing metadata, unsupported-family, parser, schema, or unknown failures as generic transient retries.
- Re-running an unchanged application runtime when the selected action required adapter or parser implementation.
- Letting a retry timestamp by itself make an otherwise identical approach novel.
- Keeping only coarse closeout counts without a reusable record of which engineering approach worked, failed, or became stale.
- Manually duplicating adapter capability lists in docs without checking them against the central registry.

### Process Decision

- True transient retry classes are limited to rate limit, provider 5xx, timeout, and network failures.
- Discovery and implementation-required work must advance to a different safe stage or reusable change, or reach the bounded human-review/final endpoint.
- A stable attempt signature must cover strategy, stage, normalized provider/failure state, runtime, material provider evidence, and reader capability. The same signature cannot consume another responder implementation cycle.
- Reopen only for a material change, a new exact release, a new compatible reader capability, changed current official evidence, or a matured persisted transient retry gate.
- Keep one privacy-safe Markdown note per provider family, updated only for reusable learning. Postgres remains authoritative and must enforce the novelty rule.
- Keep provider capability status sourced from the central registry and test documentation claims against it so notes do not become a second stale registry.

### Success Measures

- Zero repeated claims for an unchanged attempt signature.
- Zero unchanged-runtime verification cycles for adapter-repair actions.
- Zero incidents left in automatic investigation beyond the bounded endpoint.
- Every responder batch either advances a safe stage, changes reusable implementation/evidence, restores monitoring, records a factual final, or reaches a concrete human-review endpoint.
- Track created versus resolved incidents, exact-runtime restorations, classifications, repeated-signature suppressions, no-progress closeouts, courses restored per reusable release, and same-fingerprint reopen rates.

### Durable Guardrails Added During Review

- A claimed path or closeout label is not proof that technical work ran. Count an approach only from a deployed runtime change, exact current-runtime provider execution, a post-claim playbook event, or a durable terminal result.
- Track zero-work operational failures separately from the technical attempt budget. Allow only a bounded unchanged retry, then wait for a named environment, runtime, provider, or operator change.
- An implementation-required batch must include a committed runtime-bearing path. Documentation and tests may accompany the change but cannot satisfy implementation by themselves.
- Reserve the single implementation checkout as soon as the route requires code, before the first path is claimed, so verification work cannot steal it.
- Use one shared semantic provider projection for retry signatures and material-change detection. Configuration that affects execution may reopen work; refresh timestamps alone may not.
- A successful deployed reusable provider repair may wake eligible parked incidents for that same family. An unrelated deployment must not reopen them.
- Parked state, exact-runtime success, and factual final classifications use serialized compare-and-set transitions so a stale responder cannot overwrite newer truth.
