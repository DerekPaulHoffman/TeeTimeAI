ALTER TYPE "CourseMonitoringMode" ADD VALUE IF NOT EXISTS 'SERVER_ONLY';
ALTER TYPE "CourseMonitoringMode" ADD VALUE IF NOT EXISTS 'BROWSER_ONLY';
ALTER TYPE "CourseMonitoringMode" ADD VALUE IF NOT EXISTS 'CONTACT_ONLY';
ALTER TYPE "CourseSupportResolution"
ADD VALUE IF NOT EXISTS 'TECHNICAL_LIMITATION_CLASSIFIED';

ALTER TABLE "LocalReaderJob"
ADD COLUMN "requiredCapabilityKey" TEXT,
ADD COLUMN "requiredParserVersion" INTEGER;

CREATE INDEX "LocalReaderJob_requiredCapability_status_expires_idx"
ON "LocalReaderJob"("requiredCapabilityKey", "status", "jobExpiresAt");

CREATE TABLE "LocalReaderAgent" (
  "deviceId" TEXT NOT NULL,
  "readerVersion" TEXT NOT NULL,
  "buildId" TEXT NOT NULL,
  "capabilities" JSONB NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "lastSuccessfulAt" TIMESTAMP(3),
  "lastSuccessfulCapability" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LocalReaderAgent_pkey" PRIMARY KEY ("deviceId")
);

CREATE INDEX "LocalReaderAgent_lastSeenAt_idx"
ON "LocalReaderAgent"("lastSeenAt");

CREATE INDEX "LocalReaderAgent_lastSuccessfulAt_idx"
ON "LocalReaderAgent"("lastSuccessfulAt");

ALTER TABLE "CourseSupportVerificationRequest"
ADD COLUMN "deadlineAt" TIMESTAMP(3);

UPDATE "CourseSupportVerificationRequest"
SET "deadlineAt" = LEAST(
  "createdAt" + INTERVAL '12 minutes',
  "createdAt" + INTERVAL '30 minutes'
)
WHERE "deadlineAt" IS NULL;

ALTER TABLE "CourseSupportVerificationRequest"
ALTER COLUMN "deadlineAt" SET NOT NULL;

CREATE INDEX "CourseSupportVerification_status_deadline_idx"
ON "CourseSupportVerificationRequest"("status", "deadlineAt");

UPDATE "Course"
SET "monitoringMode" = 'CONTACT_ONLY'
WHERE "monitoringMode" = 'AUTOMATIC'
  AND "bookingMethod" IN ('PHONE_ONLY', 'CONTACT_COURSE', 'WALK_IN')
  AND "automationReason" = 'NO_ONLINE_BOOKING';
