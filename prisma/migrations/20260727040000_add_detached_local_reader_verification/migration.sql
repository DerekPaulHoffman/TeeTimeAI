CREATE TYPE "LocalReaderJobPurpose" AS ENUM ('ALERT_CHECK', 'COURSE_VERIFICATION');

ALTER TABLE "LocalReaderJob"
  ALTER COLUMN "teeSearchId" DROP NOT NULL,
  ALTER COLUMN "scheduleVersion" DROP NOT NULL,
  ADD COLUMN "purpose" "LocalReaderJobPurpose" NOT NULL DEFAULT 'ALERT_CHECK',
  ADD COLUMN "verificationKey" TEXT;

CREATE UNIQUE INDEX "LocalReaderJob_verificationKey_key"
  ON "LocalReaderJob"("verificationKey");

CREATE INDEX "LocalReaderJob_purpose_status_jobExpiresAt_idx"
  ON "LocalReaderJob"("purpose", "status", "jobExpiresAt");
