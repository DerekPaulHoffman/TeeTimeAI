-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SearchStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AutomationEligibility" AS ENUM ('UNKNOWN', 'ALLOWED', 'BLOCKED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "DetectedPlatform" AS ENUM ('UNKNOWN', 'FOREUP', 'GOLFNOW', 'TEEITUP', 'CHRONOGOLF', 'CLUB_CADDIE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ProbeOutcome" AS ENUM ('MATCH_FOUND', 'NO_MATCH', 'BLOCKED_POLICY', 'BLOCKED_AUTH', 'BLOCKED_TOOLING', 'FETCH_FAILED', 'NEEDS_ADAPTER');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('PENDING', 'SENT', 'SUPPRESSED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "googlePlaceId" TEXT,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "rating" DOUBLE PRECISION,
    "website" TEXT,
    "phone" TEXT,
    "photoName" TEXT,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "detectedBookingUrl" TEXT,
    "detectedPlatform" "DetectedPlatform" NOT NULL DEFAULT 'UNKNOWN',
    "automationEligibility" "AutomationEligibility" NOT NULL DEFAULT 'UNKNOWN',
    "policyNotes" TEXT,
    "bookingMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeeSearch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "players" INTEGER NOT NULL,
    "cadenceMinutes" INTEGER NOT NULL DEFAULT 15,
    "status" "SearchStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeeSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoursePreference" (
    "id" TEXT NOT NULL,
    "teeSearchId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoursePreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseProbe" (
    "id" TEXT NOT NULL,
    "teeSearchId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "automationRunId" TEXT,
    "outcome" "ProbeOutcome" NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "message" TEXT,
    "evidenceUrl" TEXT,
    "rawSummary" JSONB,

    CONSTRAINT "CourseProbe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeeTimeMatch" (
    "id" TEXT NOT NULL,
    "teeSearchId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "availableSpots" INTEGER NOT NULL,
    "priceCents" INTEGER,
    "holes" INTEGER,
    "bookingUrl" TEXT NOT NULL,
    "evidenceUrl" TEXT,
    "alertStatus" "AlertStatus" NOT NULL DEFAULT 'PENDING',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "TeeTimeMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "errors" JSONB,
    "changedFiles" JSONB,
    "notes" TEXT,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkUserId_key" ON "User"("clerkUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Course_googlePlaceId_key" ON "Course"("googlePlaceId");

-- CreateIndex
CREATE INDEX "Course_latitude_longitude_idx" ON "Course"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "Course_detectedPlatform_automationEligibility_idx" ON "Course"("detectedPlatform", "automationEligibility");

-- CreateIndex
CREATE INDEX "TeeSearch_status_date_idx" ON "TeeSearch"("status", "date");

-- CreateIndex
CREATE INDEX "TeeSearch_userId_status_idx" ON "TeeSearch"("userId", "status");

-- CreateIndex
CREATE INDEX "CoursePreference_courseId_idx" ON "CoursePreference"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "CoursePreference_teeSearchId_courseId_key" ON "CoursePreference"("teeSearchId", "courseId");

-- CreateIndex
CREATE UNIQUE INDEX "CoursePreference_teeSearchId_rank_key" ON "CoursePreference"("teeSearchId", "rank");

-- CreateIndex
CREATE INDEX "CourseProbe_teeSearchId_observedAt_idx" ON "CourseProbe"("teeSearchId", "observedAt");

-- CreateIndex
CREATE INDEX "CourseProbe_courseId_observedAt_idx" ON "CourseProbe"("courseId", "observedAt");

-- CreateIndex
CREATE INDEX "TeeTimeMatch_alertStatus_firstSeenAt_idx" ON "TeeTimeMatch"("alertStatus", "firstSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "TeeTimeMatch_teeSearchId_courseId_sourceId_startsAt_key" ON "TeeTimeMatch"("teeSearchId", "courseId", "sourceId", "startsAt");

-- AddForeignKey
ALTER TABLE "TeeSearch" ADD CONSTRAINT "TeeSearch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoursePreference" ADD CONSTRAINT "CoursePreference_teeSearchId_fkey" FOREIGN KEY ("teeSearchId") REFERENCES "TeeSearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoursePreference" ADD CONSTRAINT "CoursePreference_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseProbe" ADD CONSTRAINT "CourseProbe_teeSearchId_fkey" FOREIGN KEY ("teeSearchId") REFERENCES "TeeSearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseProbe" ADD CONSTRAINT "CourseProbe_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseProbe" ADD CONSTRAINT "CourseProbe_automationRunId_fkey" FOREIGN KEY ("automationRunId") REFERENCES "AutomationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimeMatch" ADD CONSTRAINT "TeeTimeMatch_teeSearchId_fkey" FOREIGN KEY ("teeSearchId") REFERENCES "TeeSearch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeeTimeMatch" ADD CONSTRAINT "TeeTimeMatch_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
