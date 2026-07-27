# Dependency risk register

Last reviewed: 2026-07-27

Owner: Tee Time Spot engineering
Next review: 2026-08-03

## Workflow toolchain advisory

`npm audit --omit=dev` reports `GHSA-mh99-v99m-4gvg` through the
`workflow@4.6.0` build and CLI dependency tree. The affected chain includes
`@workflow/cli`, `@workflow/nest`, `@swc/cli`, `@oclif/core`,
`@oclif/plugin-help`, `ejs`, `jake`, `filelist`, `minimatch`, and
`brace-expansion`.

The vulnerable expansion code is part of the Workflow compilation and CLI
toolchain. Tee Time Spot does not pass customer-controlled glob patterns to
that toolchain at runtime. This lowers the current application exposure, but
does not remove the dependency risk because Workflow is a production
dependency and its compiler runs during builds.

Do not run `npm audit fix --force`. npm currently proposes
`workflow@2.0.6`, an incompatible downgrade from the deployed 4.x API.

Commit `1070095` previously moved Workflow from 4.6.0 to 4.6.2 and added
transitive overrides. Commit `51971a7` reverted that exact package-only
change without recording a failing command or runtime reason. The repository
therefore does not contain enough evidence to attribute the revert to one
specific failure. Treat the combined Workflow upgrade and override set as
unverified rather than assuming it was safe or broken.

Before a future Workflow upgrade is accepted, verify all of the following
against an isolated preview:

1. dependency installation and production build;
2. Workflow compilation;
3. initial start, durable sleep, and latest-deployment successor launch;
4. failed-start queue fallback and cron recovery;
5. schedule-version and lease compare-and-set behavior;
6. a production-shaped smoke with exact Git/deployment parity.

Until those checks pass, keep Workflow pinned at 4.6.0 and review the
upstream dependency tree on the date above.

## Prisma patch

`prisma`, `@prisma/client`, `@prisma/adapter-neon`, and
`@prisma/adapter-pg` are upgraded together to 7.9.1. This is a patch update
and is verified through client generation, schema validation, type checking,
tests, and the production build.

## Retention boundary

No retention deletion is authorized by this change. Use
`npm run automation:inspect-storage` through the intended environment to
read aggregate row counts and relation sizes for append-only operational
tables. Approve explicit retention windows before deleting expired
`LocalReaderJob` rows, synthetic analytics, probes, discoveries, monitoring
events, or automation audit history.

The read-only production snapshot at 2026-07-27T21:24:53Z was:

| Relation | Rows | Total relation size |
| --- | ---: | ---: |
| `CourseProbe` | 45,424 | 34.40 MiB |
| `AutomationRun` | 17,810 | 32.82 MiB |
| `WebsiteEvent` | 21,749 | 7.26 MiB |
| `CourseAutomationDiscovery` | 937 | 6.23 MiB |
| `CourseMonitoringEvent` | 4,116 | 2.55 MiB |
| `LocalReaderJob` | 435 | 0.77 MiB |
| `WebsiteFeedback` | 8 | 0.08 MiB |

These sizes do not justify an emergency retention policy. Preserve the
history until product and operational owners approve explicit windows.
