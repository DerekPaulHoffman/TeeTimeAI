BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "TeeSearch" ADD COLUMN "setupStartedAt" TIMESTAMP(3);
ALTER TABLE "CourseDiscoveryJob" ADD COLUMN "setupDeadlineAt" TIMESTAMP(3);
CREATE INDEX "CourseDiscoveryJob_status_setupDeadlineAt_idx" ON "CourseDiscoveryJob"("status", "setupDeadlineAt");

COMMIT;
