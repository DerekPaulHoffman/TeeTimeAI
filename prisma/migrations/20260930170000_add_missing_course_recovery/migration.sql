-- CreateEnum
CREATE TYPE "CourseRecoveryStatus" AS ENUM ('QUEUED', 'INVESTIGATING', 'RETRY_WAIT', 'VERIFIED', 'NEEDS_DETAILS', 'NOT_PUBLIC', 'UNRESOLVED', 'ACCESS_LIMITED');

-- CreateEnum
CREATE TYPE "CourseRecoveryDemandStatus" AS ENUM ('WAITING', 'ACTIVATED', 'CANCELLED', 'EXPIRED', 'ACTION_REQUIRED');

-- CreateTable
CREATE TABLE "CourseRecoveryRequest" (
    "id" TEXT NOT NULL,
    "identityKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "town" TEXT NOT NULL,
    "address" TEXT,
    "officialWebsite" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "status" "CourseRecoveryStatus" NOT NULL DEFAULT 'QUEUED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "workflowRunId" TEXT,
    "reason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "humanRequiredAt" TIMESTAMP(3),
    "courseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseRecoveryRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseRecoveryAttempt" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "evidenceUrl" TEXT,
    "evidenceSummary" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseRecoveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseRecoveryAdmission" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseRecoveryAdmission_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "CourseRecoveryDemand" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "CourseRecoveryDemandStatus" NOT NULL DEFAULT 'WAITING',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL,
    "trafficClass" "WebsiteTrafficClass" NOT NULL DEFAULT 'UNCLASSIFIED',
    "reason" TEXT,
    "teeSearchId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseRecoveryDemand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CourseRecoveryRequest_identityKey_key" ON "CourseRecoveryRequest"("identityKey");

-- CreateIndex
CREATE INDEX "CourseRecoveryRequest_status_nextAttemptAt_idx" ON "CourseRecoveryRequest"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "CourseRecoveryRequest_createdAt_idx" ON "CourseRecoveryRequest"("createdAt");

-- CreateIndex
CREATE INDEX "CourseRecoveryRequest_courseId_idx" ON "CourseRecoveryRequest"("courseId");

-- CreateIndex
CREATE INDEX "CourseRecoveryAttempt_observedAt_idx" ON "CourseRecoveryAttempt"("observedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CourseRecoveryAttempt_requestId_revision_key" ON "CourseRecoveryAttempt"("requestId", "revision");

-- CreateIndex
CREATE INDEX "CourseRecoveryAdmission_expiresAt_idx" ON "CourseRecoveryAdmission"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CourseRecoveryDemand_teeSearchId_key" ON "CourseRecoveryDemand"("teeSearchId");

-- CreateIndex
CREATE INDEX "CourseRecoveryDemand_userId_status_idx" ON "CourseRecoveryDemand"("userId", "status");

-- CreateIndex
CREATE INDEX "CourseRecoveryDemand_status_expiresAt_idx" ON "CourseRecoveryDemand"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CourseRecoveryDemand_requestId_userId_key" ON "CourseRecoveryDemand"("requestId", "userId");

-- AddForeignKey
ALTER TABLE "CourseRecoveryRequest" ADD CONSTRAINT "CourseRecoveryRequest_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseRecoveryAttempt" ADD CONSTRAINT "CourseRecoveryAttempt_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CourseRecoveryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseRecoveryDemand" ADD CONSTRAINT "CourseRecoveryDemand_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CourseRecoveryRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseRecoveryDemand" ADD CONSTRAINT "CourseRecoveryDemand_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseRecoveryDemand" ADD CONSTRAINT "CourseRecoveryDemand_teeSearchId_fkey" FOREIGN KEY ("teeSearchId") REFERENCES "TeeSearch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
