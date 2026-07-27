ALTER TYPE "ProbeOutcome" ADD VALUE IF NOT EXISTS 'MANUAL_DIRECT';
ALTER TYPE "ProbeOutcome" ADD VALUE IF NOT EXISTS 'IDENTITY_FINAL';
ALTER TYPE "ProbeOutcome" ADD VALUE IF NOT EXISTS 'IDENTITY_RECHECK';

CREATE TYPE "AutomationRunKind" AS ENUM (
  'SEARCH_CHECK',
  'COURSE_SUPPORT',
  'IMPROVEMENT',
  'BROWSER_PROBE',
  'MAINTENANCE',
  'OTHER'
);

CREATE TYPE "AutomationRunStatus" AS ENUM (
  'RUNNING',
  'COMPLETED',
  'FAILED'
);

CREATE TYPE "AutomationWorkerDesiredState" AS ENUM ('ACTIVE', 'PAUSED');

ALTER TABLE "AutomationRun"
  ADD COLUMN "kind" "AutomationRunKind" NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "status" "AutomationRunStatus" NOT NULL DEFAULT 'RUNNING',
  ADD COLUMN "runtimeVersion" TEXT,
  ADD COLUMN "ownerThreadId" TEXT,
  ADD COLUMN "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN "auditSchemaVersion" INTEGER,
  ADD COLUMN "audit" JSONB;

UPDATE "AutomationRun"
SET "status" = CASE
  WHEN "completedAt" IS NULL THEN 'RUNNING'::"AutomationRunStatus"
  WHEN "outcome" IN ('failed', 'error', 'blocked_env', 'blocked_tooling', 'blocked_git')
    THEN 'FAILED'::"AutomationRunStatus"
  ELSE 'COMPLETED'::"AutomationRunStatus"
END;

CREATE INDEX "AutomationRun_kind_startedAt_idx"
  ON "AutomationRun"("kind", "startedAt");
CREATE INDEX "AutomationRun_status_startedAt_idx"
  ON "AutomationRun"("status", "startedAt");

CREATE TABLE "AutomationWorkerState" (
  "workerKey" TEXT NOT NULL,
  "desiredState" "AutomationWorkerDesiredState" NOT NULL DEFAULT 'ACTIVE',
  "cadenceSeconds" INTEGER NOT NULL,
  "graceSeconds" INTEGER NOT NULL,
  "runnerVersion" TEXT,
  "runtimeVersion" TEXT,
  "lastStartedAt" TIMESTAMP(3),
  "lastHeartbeatAt" TIMESTAMP(3),
  "lastCompletedAt" TIMESTAMP(3),
  "lastOutcome" TEXT,
  "nextExpectedAt" TIMESTAMP(3),
  "monitoringStartedAt" TIMESTAMP(3),
  "overdueSince" TIMESTAMP(3),
  "overdueNotifiedFor" TIMESTAMP(3),
  "overdueNotifiedAt" TIMESTAMP(3),
  "recoveredNotifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AutomationWorkerState_pkey" PRIMARY KEY ("workerKey")
);

CREATE INDEX "AutomationWorkerState_desiredState_nextExpectedAt_idx"
  ON "AutomationWorkerState"("desiredState", "nextExpectedAt");
CREATE INDEX "AutomationWorkerState_lastHeartbeatAt_idx"
  ON "AutomationWorkerState"("lastHeartbeatAt");
