CREATE TYPE "CourseDiscoveryJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');
ALTER TYPE "LocalReaderJobPurpose" ADD VALUE 'RECIPE_CHECK';

ALTER TABLE "Course" ADD COLUMN "activeAccessRecipeId" TEXT;
ALTER TABLE "CourseOffering" ADD COLUMN "activeAccessRecipeId" TEXT;

CREATE TABLE "CourseDiscoveryJob" (
  "id" TEXT NOT NULL,
  "targetKey" TEXT NOT NULL,
  "activeTargetKey" TEXT,
  "courseId" TEXT NOT NULL,
  "offeringId" TEXT,
  "sourceFingerprint" TEXT NOT NULL,
  "baseRecipeId" TEXT,
  "status" "CourseDiscoveryJobStatus" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "workerId" TEXT,
  "firstPickedUpAt" TIMESTAMP(3),
  "deadlineAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "checkpoint" JSONB,
  "request" JSONB NOT NULL,
  "candidate" JSONB,
  "candidateHash" TEXT,
  "verification" JSONB,
  "outcome" TEXT,
  "result" JSONB,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourseDiscoveryJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CourseDiscoveryJob_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CourseDiscoveryJob_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CourseDiscoveryJob_attempts_check" CHECK ("attempts" BETWEEN 0 AND 2)
);

CREATE UNIQUE INDEX "CourseDiscoveryJob_activeTargetKey_key" ON "CourseDiscoveryJob"("activeTargetKey");
CREATE INDEX "CourseDiscoveryJob_status_leaseExpiresAt_createdAt_idx" ON "CourseDiscoveryJob"("status", "leaseExpiresAt", "createdAt");
CREATE INDEX "CourseDiscoveryJob_targetKey_createdAt_idx" ON "CourseDiscoveryJob"("targetKey", "createdAt");

CREATE TABLE "CourseAccessRecipe" (
  "id" TEXT NOT NULL,
  "targetKey" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "offeringId" TEXT,
  "version" INTEGER NOT NULL,
  "hash" TEXT NOT NULL,
  "sourceFingerprint" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "verification" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourseAccessRecipe_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CourseAccessRecipe_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CourseAccessRecipe_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CourseAccessRecipe_version_check" CHECK ("version" > 0)
);

CREATE UNIQUE INDEX "CourseAccessRecipe_targetKey_version_key" ON "CourseAccessRecipe"("targetKey", "version");
CREATE INDEX "CourseAccessRecipe_targetKey_hash_idx" ON "CourseAccessRecipe"("targetKey", "hash");
