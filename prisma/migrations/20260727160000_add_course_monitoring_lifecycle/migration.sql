ALTER TYPE "CourseSupportIncidentKind"
  ADD VALUE IF NOT EXISTS 'READER_CANDIDATE';

ALTER TYPE "CourseSupportResolution"
  ADD VALUE IF NOT EXISTS 'HUMAN_VERIFIED_TECHNICAL_LIMITATION';

ALTER TYPE "CourseSupportFailureClass"
  ADD VALUE IF NOT EXISTS 'READER_PARSER_MISSING';

CREATE TYPE "CourseMonitoringState" AS ENUM (
  'UNKNOWN',
  'HEALTHY',
  'DEGRADED_RETRYING',
  'AUTO_INVESTIGATING',
  'ENGINEERING_VERIFICATION_NEEDED',
  'REVALIDATING_FINAL',
  'FINAL_MANUAL',
  'FINAL_TECHNICAL',
  'FINAL_IDENTITY'
);

CREATE TYPE "CourseMonitoringEventType" AS ENUM (
  'BASELINE_IMPORTED',
  'CHECK_SUCCEEDED',
  'CHECK_FAILED',
  'STATE_CHANGED',
  'AUTOMATION_ATTEMPTED',
  'TOOLING_INCIDENT',
  'HUMAN_REVIEW_REQUESTED',
  'HUMAN_DECISION',
  'REVALIDATION_REQUESTED',
  'RECOVERED',
  'DEPLOYMENT_VERIFIED',
  'REMINDER_SENT'
);

CREATE TYPE "CourseMonitoringEventSource" AS ENUM (
  'SEARCH_WORKFLOW',
  'COURSE_SUPPORT_RESPONDER',
  'LOCAL_READER',
  'RECOVERY_CRON',
  'OPERATOR_DASHBOARD',
  'OPERATOR_CLI',
  'MAINTENANCE',
  'DEPLOYMENT'
);

CREATE TYPE "CourseHumanReviewReason" AS ENUM (
  'CAPTCHA_OR_QUEUE',
  'ACCOUNT_REQUIRED',
  'SOURCE_UNVERIFIED',
  'READER_RELOAD_REQUIRED',
  'OFFICIAL_LINK_VERIFICATION_FAILED',
  'OTHER_TECHNICAL_LIMITATION'
);

ALTER TABLE "CourseSupportIncident"
  ADD COLUMN "reference" TEXT,
  ADD COLUMN "confirmedAt" TIMESTAMP(3),
  ADD COLUMN "escalationDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "humanReviewReason" "CourseHumanReviewReason",
  ADD COLUMN "nextReminderAt" TIMESTAMP(3),
  ADD COLUMN "decisionActorId" TEXT,
  ADD COLUMN "decisionAt" TIMESTAMP(3),
  ADD COLUMN "decisionNote" TEXT,
  ADD COLUMN "decisionEvidenceUrl" TEXT,
  ADD COLUMN "decisionIdempotencyKey" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

UPDATE "CourseSupportIncident"
SET "reference" = 'csi_' || substr(md5("id" || clock_timestamp()::text || random()::text), 1, 24)
WHERE "reference" IS NULL;

ALTER TABLE "CourseSupportIncident"
  ALTER COLUMN "reference" SET NOT NULL;

CREATE UNIQUE INDEX "CourseSupportIncident_reference_key"
  ON "CourseSupportIncident"("reference");
CREATE UNIQUE INDEX "CourseSupportIncident_decisionIdempotencyKey_key"
  ON "CourseSupportIncident"("decisionIdempotencyKey");
CREATE INDEX "CourseSupportIncident_status_escalationDeadlineAt_idx"
  ON "CourseSupportIncident"("status", "escalationDeadlineAt");
CREATE INDEX "CourseSupportIncident_status_nextReminderAt_idx"
  ON "CourseSupportIncident"("status", "nextReminderAt");

CREATE TABLE "CourseMonitoringStatus" (
  "courseId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "state" "CourseMonitoringState" NOT NULL DEFAULT 'UNKNOWN',
  "lastSuccessfulAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "failureFingerprint" TEXT,
  "firstDegradedAt" TIMESTAMP(3),
  "nextAutomaticAttemptAt" TIMESTAMP(3),
  "revalidationRequestedAt" TIMESTAMP(3),
  "stateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourseMonitoringStatus_pkey" PRIMARY KEY ("courseId"),
  CONSTRAINT "CourseMonitoringStatus_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CourseMonitoringStatus_reference_key"
  ON "CourseMonitoringStatus"("reference");
CREATE INDEX "CourseMonitoringStatus_state_nextAutomaticAttemptAt_idx"
  ON "CourseMonitoringStatus"("state", "nextAutomaticAttemptAt");
CREATE INDEX "CourseMonitoringStatus_revalidationRequestedAt_idx"
  ON "CourseMonitoringStatus"("revalidationRequestedAt");
CREATE INDEX "CourseMonitoringStatus_lastSuccessfulAt_idx"
  ON "CourseMonitoringStatus"("lastSuccessfulAt");

CREATE TABLE "CourseMonitoringEvent" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "incidentId" TEXT,
  "eventType" "CourseMonitoringEventType" NOT NULL,
  "source" "CourseMonitoringEventSource" NOT NULL,
  "fromState" "CourseMonitoringState",
  "toState" "CourseMonitoringState",
  "outcome" "ProbeOutcome",
  "failureFingerprint" TEXT,
  "readPath" TEXT,
  "message" TEXT,
  "evidenceUrl" TEXT,
  "runtimeVersion" TEXT,
  "deploymentSha" TEXT,
  "operatorActorId" TEXT,
  "idempotencyKey" TEXT,
  "audit" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourseMonitoringEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CourseMonitoringEvent_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CourseMonitoringEvent_incidentId_fkey"
    FOREIGN KEY ("incidentId") REFERENCES "CourseSupportIncident"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CourseMonitoringEvent_idempotencyKey_key"
  ON "CourseMonitoringEvent"("idempotencyKey");
CREATE INDEX "CourseMonitoringEvent_courseId_occurredAt_idx"
  ON "CourseMonitoringEvent"("courseId", "occurredAt");
CREATE INDEX "CourseMonitoringEvent_incidentId_occurredAt_idx"
  ON "CourseMonitoringEvent"("incidentId", "occurredAt");
CREATE INDEX "CourseMonitoringEvent_eventType_occurredAt_idx"
  ON "CourseMonitoringEvent"("eventType", "occurredAt");
CREATE INDEX "CourseMonitoringEvent_occurredAt_idx"
  ON "CourseMonitoringEvent"("occurredAt");
