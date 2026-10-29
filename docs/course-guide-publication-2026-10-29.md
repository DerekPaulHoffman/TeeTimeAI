# Course guide publication — October 29, 2026

Owner run: `cmvt25b9600008g159mcz450k`; thread: `01a185f6-ef2f-7160-a0d6-c07c1617aa3c`.
Branch: `automation/hourly-course-guides-20261029-010000`.
Starting main: `d0ee3e62f1de3149fcf6774e9db1a746ce52dd36`.
This path was claimed before editing; drafts and receipts remain outside Git at
`C:\dev\scratchpads\course-guides-20261029-01a185f6`.

## Published guides

- Gateway National Golf Links, Madison, Illinois: https://teetimespot.com/courses/golf-course-madison-il
  Sources: https://www.gatewaynational.com/ and https://gatewaynational.com/golf/.
- Arlington Greens Golf Course, Granite City, Illinois: https://teetimespot.com/courses/golf-course-granite-city-il
  Sources: https://www.arlingtongreens.com/ and https://www.arlingtongreens.com/course-info/.
  Official physical layout and par evidence supports 18 holes, par 72.

Both research packets were read, both drafts passed dry-run validation, and both
apply commands returned `mode=applied`, `valid=true`. Readback confirms PUBLISHED
status with two durable sources each. Published profiles increased 149 to 151;
stale profiles stayed 9; visible profiles increased 158 to 160. Actionable queue
decreased 25 to 23; missing-location queue stayed 47.

## Verification and boundaries

Live browser checks passed at widths 1440 and 390 for both canonical pages:
HTTP 200, course title, description, canonical URL and parseable GolfCourse /
Breadcrumb structured data. Both profiles appear in the course hub and sitemap;
the pages expose official-site and internal navigation links. All eight observed
browser analytics requests carried AUTOMATION traffic class. Focused profile
validation and presentation tests passed: 15 tests across two files, 770 ms.
Dependency inventory passed and package lock/schema have not changed since the
previous verified install/generation. Production project and Neon binding matched.

The batch rotated past previously rejected Hobe Sound, Executive, Meadowbrook
and Copper Creek candidates using the prior run's evidence. No access
classification, booking configuration, customer demand, search checks, email,
responder state, application code or deployment was changed. No new migration
was required. Publication is database-backed; this commit records the result.
The six-hour cadence and independent hourly writer lane remain unchanged.
