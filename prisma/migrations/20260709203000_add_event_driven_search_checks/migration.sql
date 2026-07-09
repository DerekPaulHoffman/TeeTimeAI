CREATE TYPE "SearchCheckStatus" AS ENUM ('IDLE', 'QUEUED', 'CHECKING', 'WAITING', 'FAILED', 'STOPPED');

CREATE TYPE "MatchAvailabilityStatus" AS ENUM ('AVAILABLE', 'GONE', 'UNKNOWN');

ALTER TABLE "TeeSearch"
ADD COLUMN "checkStatus" "SearchCheckStatus" NOT NULL DEFAULT 'IDLE',
ADD COLUMN "scheduleVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "workflowRunId" TEXT,
ADD COLUMN "nextCheckAt" TIMESTAMP(3),
ADD COLUMN "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN "lastCheckOutcome" TEXT;

ALTER TABLE "TeeTimeMatch"
ADD COLUMN "availabilityStatus" "MatchAvailabilityStatus" NOT NULL DEFAULT 'AVAILABLE',
ADD COLUMN "lastConfirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "unavailableAt" TIMESTAMP(3);

CREATE INDEX "TeeSearch_status_nextCheckAt_idx" ON "TeeSearch"("status", "nextCheckAt");
CREATE INDEX "TeeTimeMatch_teeSearchId_availabilityStatus_startsAt_idx"
ON "TeeTimeMatch"("teeSearchId", "availabilityStatus", "startsAt");
