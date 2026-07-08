# TeeTimeAI

TeeTimeAI is a JS/Postgres proof of concept for finding better public golf tee times from user preferences.

Users sign in, discover nearby public courses, rank 1 to 5 favorites, choose a future date/time window and player count, then receive email alerts when the local Codex automation finds a new matching tee time. The POC is alert-only: users finish booking on the official course site.

## Stack

- Next.js 16 + React 19
- Prisma 7 + Neon Postgres
- Clerk full accounts
- Resend transactional email
- Google Places nearby course discovery
- Vitest unit/integration tests

## Local Setup

```powershell
npm install
Copy-Item .env.example .env.local
npm run prisma:generate
npm run dev
```

The homepage can preview with demo course data before API keys are configured. Saving searches and dashboard data require `DATABASE_URL`, Clerk keys, and a migrated database.

## Database

```powershell
npm run prisma:migrate
npm run seed:foreup
```

The seed script adds the first known ForeUP adapter data for Tashua Knolls and H. Smith Richardson.

## Automation

```powershell
npm run automation:poll
npm run automation:improve
```

`automation:poll` reads active searches, checks supported course adapters, records per-course probes, upserts new matches, and sends Resend alerts. `automation:improve` writes the Codex loop prompt into an `AutomationRun` row so a scheduled Codex session can inspect failures and improve adapters/UI.

See `docs/codex-automation-loop.md` for boundaries and run contract.

## Validation

```powershell
npm run test:run
npm run lint
npm run build
```

The legacy Python crawler prototype is preserved under `legacy/python-crawler`.
