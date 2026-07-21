CREATE TYPE "CourseSupportVerificationStatus" AS ENUM (
  'QUEUED',
  'CHECKING',
  'SUCCEEDED',
  'RETRYABLE_FAILED',
  'STALE'
);

CREATE TABLE "CourseSupportVerificationRequest" (
  "id" TEXT NOT NULL,
  "batchIncidentId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "releaseSha" TEXT NOT NULL,
  "runtimeVersion" TEXT,
  "status" "CourseSupportVerificationStatus" NOT NULL DEFAULT 'QUEUED',
  "revision" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "workflowRunId" TEXT,
  "nextAttemptAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "targetDateLocal" TEXT NOT NULL,
  "startTimeLocal" TEXT NOT NULL DEFAULT '06:00',
  "endTimeLocal" TEXT NOT NULL DEFAULT '20:00',
  "timeZone" TEXT NOT NULL,
  "players" INTEGER NOT NULL DEFAULT 1,
  "providerFamilyKeySnapshot" TEXT NOT NULL,
  "platformSnapshot" "DetectedPlatform" NOT NULL,
  "bookingMethodSnapshot" "BookingMethod" NOT NULL,
  "automationEligibilitySnapshot" "AutomationEligibility" NOT NULL,
  "automationReasonSnapshot" "AutomationReason" NOT NULL,
  "providerSnapshotFingerprint" TEXT NOT NULL,
  "providerSnapshotAt" TIMESTAMP(3) NOT NULL,
  "discoveryAttemptedAt" TIMESTAMP(3),
  "discoveryVerifiedAt" TIMESTAMP(3),
  "outcome" "ProbeOutcome",
  "failureClass" "CourseSupportFailureClass",
  "evidence" JSONB,
  "lastError" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourseSupportVerificationRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CourseSupportVerification_release_sha_check"
    CHECK ("releaseSha" ~ '^[0-9a-fA-F]{40}$'),
  CONSTRAINT "CourseSupportVerification_runtime_release_check"
    CHECK ("runtimeVersion" IS NULL OR "runtimeVersion" = "releaseSha"),
  CONSTRAINT "CourseSupportVerification_execution_state_check"
    CHECK (
      ("status" <> 'CHECKING' OR (
        "runtimeVersion" = "releaseSha"
        AND "leaseToken" IS NOT NULL
        AND "leaseExpiresAt" IS NOT NULL
        AND "startedAt" IS NOT NULL
      ))
      AND (
        "status" NOT IN ('QUEUED', 'RETRYABLE_FAILED')
        OR "nextAttemptAt" IS NOT NULL
      )
      AND (
        "status" <> 'RETRYABLE_FAILED'
        OR "nextAttemptAt" < "createdAt" + INTERVAL '24 hours'
      )
      AND (
        "status" = 'CHECKING'
        OR ("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
      )
      AND "revision" >= 0
      AND "attemptCount" >= 0
    ),
  CONSTRAINT "CourseSupportVerification_succeeded_evidence_check"
    CHECK (
      "status" <> 'SUCCEEDED' OR COALESCE((
        "runtimeVersion" = "releaseSha"
        AND "outcome" IS NOT NULL
        AND "completedAt" IS NOT NULL
        AND "evidence" IS NOT NULL
        AND "evidence"->>'schemaVersion' = '1'
        AND "evidence"->>'kind' = 'PROVIDER_VERIFICATION'
        AND "evidence"->>'releaseSha' = "releaseSha"
        AND "evidence"->>'runtimeVersion' = "releaseSha"
        AND "evidence"->>'observedAt' IS NOT NULL
        AND "evidence"->>'outcome' = "outcome"::text
        AND "evidence"->>'providerSnapshotFingerprint' = "providerSnapshotFingerprint"
        AND "evidence"->>'providerExecution' IN ('true', 'false')
        AND (
          "outcome" NOT IN ('MATCH_FOUND', 'NO_MATCH')
          OR (
            "discoveryAttemptedAt" IS NOT NULL
            AND "discoveryVerifiedAt" IS NOT NULL
            AND "discoveryVerifiedAt" >= "discoveryAttemptedAt"
            AND "completedAt" >= "discoveryVerifiedAt"
          )
        )
        AND (
          "outcome" NOT IN ('MATCH_FOUND', 'NO_MATCH')
          OR "evidence"->>'providerExecution' = 'true'
        )
      ), false)
    ),
  CONSTRAINT "CourseSupportVerification_discovery_state_check"
    CHECK (
      "discoveryVerifiedAt" IS NULL
      OR (
        "discoveryAttemptedAt" IS NOT NULL
        AND "discoveryVerifiedAt" >= "discoveryAttemptedAt"
      )
    ),
  CONSTRAINT "CourseSupportVerification_intent_check"
    CHECK (
      "players" = 1
      AND "startTimeLocal" = '06:00'
      AND "endTimeLocal" = '20:00'
      AND "targetDateLocal" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    )
);

ALTER TABLE "CourseSupportVerificationRequest"
  ADD CONSTRAINT "CourseSupportVerification_batchIncident_fkey"
  FOREIGN KEY ("batchIncidentId") REFERENCES "CourseSupportBatchIncident"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CourseSupportVerificationRequest"
  ADD CONSTRAINT "CourseSupportVerification_course_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "CourseSupportVerification_batchIncident_release_key"
  ON "CourseSupportVerificationRequest"("batchIncidentId", "releaseSha");
CREATE INDEX "CourseSupportVerification_status_nextAttempt_idx"
  ON "CourseSupportVerificationRequest"("status", "nextAttemptAt");
CREATE INDEX "CourseSupportVerification_leaseExpiresAt_idx"
  ON "CourseSupportVerificationRequest"("leaseExpiresAt");
CREATE INDEX "CourseSupportVerification_course_status_idx"
  ON "CourseSupportVerificationRequest"("courseId", "status");
CREATE INDEX "CourseSupportVerification_release_status_idx"
  ON "CourseSupportVerificationRequest"("releaseSha", "status");
