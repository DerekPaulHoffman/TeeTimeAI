CREATE TYPE "LocalReaderJobStatus" AS ENUM (
  'PENDING',
  'LEASED',
  'COMPLETED',
  'FAILED',
  'EXPIRED'
);

CREATE TABLE "LocalReaderJob" (
  "id" TEXT NOT NULL,
  "teeSearchId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "scheduleVersion" INTEGER NOT NULL,
  "courseKey" TEXT NOT NULL,
  "targetDate" TEXT NOT NULL,
  "players" INTEGER NOT NULL,
  "bookingUrl" TEXT NOT NULL,
  "status" "LocalReaderJobStatus" NOT NULL DEFAULT 'PENDING',
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3),
  "deviceId" TEXT,
  "jobExpiresAt" TIMESTAMP(3) NOT NULL,
  "result" JSONB,
  "resultExpiresAt" TIMESTAMP(3),
  "readerVersion" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "LocalReaderJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LocalReaderJob_search_course_version_date_players_key"
ON "LocalReaderJob"(
  "teeSearchId",
  "courseId",
  "scheduleVersion",
  "targetDate",
  "players"
);

CREATE INDEX "LocalReaderJob_status_jobExpiresAt_createdAt_idx"
ON "LocalReaderJob"("status", "jobExpiresAt", "createdAt");

CREATE INDEX "LocalReaderJob_search_course_resultExpiresAt_idx"
ON "LocalReaderJob"("teeSearchId", "courseId", "resultExpiresAt");

CREATE INDEX "LocalReaderJob_leaseExpiresAt_idx"
ON "LocalReaderJob"("leaseExpiresAt");

ALTER TABLE "LocalReaderJob"
ADD CONSTRAINT "LocalReaderJob_teeSearchId_fkey"
FOREIGN KEY ("teeSearchId") REFERENCES "TeeSearch"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LocalReaderJob"
ADD CONSTRAINT "LocalReaderJob_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "Course"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
