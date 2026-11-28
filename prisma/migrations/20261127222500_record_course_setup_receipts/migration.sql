BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TYPE "CourseSetupOutcome" AS ENUM (
  'MATCHES_AVAILABLE', 'NO_OPENINGS', 'BOOKING_NOT_OPEN', 'DIRECT_ACTION',
  'UNCONFIRMED', 'LEGACY_UNVERIFIED', 'SUPERSEDED'
);

CREATE TABLE "CourseSetupReceipt" (
  "id" TEXT NOT NULL,
  "preferenceId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "offeringId" TEXT,
  "request" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "deadlineAt" TIMESTAMP(3) NOT NULL,
  "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "outcome" "CourseSetupOutcome",
  "evidenceProbeId" TEXT,
  "evidenceObservedAt" TIMESTAMP(3),
  "legacy" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "CourseSetupReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CourseSetupReceipt_preferenceId_fkey" FOREIGN KEY ("preferenceId") REFERENCES "CoursePreference"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CourseSetupReceipt_preferenceId_startedAt_key" ON "CourseSetupReceipt"("preferenceId", "startedAt");
CREATE INDEX "CourseSetupReceipt_outcome_deadlineAt_idx" ON "CourseSetupReceipt"("outcome", "deadlineAt");

COMMIT;
