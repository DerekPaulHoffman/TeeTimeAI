CREATE TYPE "CourseSupportFailureClass" AS ENUM (
  'MISSING_SOURCE',
  'MISSING_METADATA',
  'UNSUPPORTED_FAMILY',
  'AUTH',
  'RATE_LIMIT',
  'CHALLENGE',
  'NOT_FOUND',
  'HTTP_5XX',
  'TIMEOUT',
  'NETWORK',
  'SCHEMA',
  'UNKNOWN'
);

CREATE TYPE "CourseSupportBatchStatus" AS ENUM (
  'CLAIMED',
  'IMPLEMENTING',
  'VERIFYING',
  'SUCCEEDED',
  'PARTIAL',
  'RETRYABLE_FAILED'
);

CREATE TYPE "CourseSupportBatchIncidentResult" AS ENUM (
  'PENDING',
  'RESTORED',
  'FINAL_DISPOSITION',
  'RETRY_SCHEDULED',
  'NEEDS_HUMAN',
  'STALE_EVIDENCE'
);

CREATE TYPE "SearchEmailDeliveryKind" AS ENUM (
  'SETUP',
  'DAILY',
  'MATCH'
);

CREATE TYPE "SearchEmailDeliveryStatus" AS ENUM (
  'PENDING',
  'SENDING',
  'SENT',
  'SUPPRESSED',
  'FAILED'
);

ALTER TABLE "Course"
  ADD COLUMN "providerFamilyKey" TEXT NOT NULL DEFAULT 'SOURCE_MISSING';

ALTER TABLE "TeeSearch"
  ADD COLUMN "alertGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "checkLeaseToken" TEXT,
  ADD COLUMN "checkLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "recheckRequestedAt" TIMESTAMP(3),
  ADD COLUMN "remediationDispatchKey" TEXT,
  ADD COLUMN "remediationDispatchVersion" INTEGER;

ALTER TABLE "CourseProbe"
  ADD COLUMN "runtimeVersion" TEXT;

CREATE TABLE "SearchEmailDelivery" (
  "id" TEXT NOT NULL,
  "teeSearchId" TEXT NOT NULL,
  "alertGeneration" INTEGER NOT NULL,
  "kind" "SearchEmailDeliveryKind" NOT NULL,
  "groupKey" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "isOwnerRecipient" BOOLEAN NOT NULL DEFAULT false,
  "payload" JSONB NOT NULL,
  "status" "SearchEmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "claimToken" TEXT,
  "claimExpiresAt" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SearchEmailDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SearchEmailDelivery"
  ADD CONSTRAINT "SearchEmailDelivery_teeSearchId_fkey"
  FOREIGN KEY ("teeSearchId") REFERENCES "TeeSearch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "SearchEmailDelivery_teeSearchId_alertGeneration_kind_groupK_key"
  ON "SearchEmailDelivery"("teeSearchId", "alertGeneration", "kind", "groupKey", "recipient");
CREATE INDEX "SearchEmailDelivery_status_nextAttemptAt_idx"
  ON "SearchEmailDelivery"("status", "nextAttemptAt");
CREATE INDEX "SearchEmailDelivery_teeSearchId_alertGeneration_status_idx"
  ON "SearchEmailDelivery"("teeSearchId", "alertGeneration", "status");
CREATE INDEX "SearchEmailDelivery_claimExpiresAt_idx"
  ON "SearchEmailDelivery"("claimExpiresAt");

ALTER TABLE "CourseSupportIncident"
  ADD COLUMN "providerFamilyKey" TEXT NOT NULL DEFAULT 'SOURCE_MISSING',
  ADD COLUMN "failureClass" "CourseSupportFailureClass" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "failureFingerprint" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "activeRealSearchCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "earliestTargetDate" TIMESTAMP(3),
  ADD COLUMN "activeBatchId" TEXT;

UPDATE "Course"
SET "providerFamilyKey" = CASE
  WHEN "detectedPlatform"::text = 'FOREUP' THEN 'FOREUP'
  WHEN "detectedPlatform"::text = 'TEEITUP' THEN 'TEEITUP'
  WHEN "detectedPlatform"::text = 'CHRONOGOLF' THEN 'CHRONOGOLF'
  WHEN "detectedPlatform"::text = 'GOLFNOW' THEN 'GOLFNOW'
  WHEN "detectedPlatform"::text = 'CLUB_CADDIE' THEN 'CLUB_CADDIE'
  WHEN "detectedPlatform"::text = 'CUSTOM'
    AND upper(COALESCE("bookingMetadata"->>'provider', '')) IN (
      'CPS', 'CHELSEA', 'TEESNAP', 'GOLFBACK', 'WEBTRAC'
    )
    THEN upper("bookingMetadata"->>'provider')
  ELSE 'SOURCE_MISSING'
END;

UPDATE "CourseSupportIncident" AS incident
SET
  "providerFamilyKey" = course."providerFamilyKey",
  "failureClass" = CASE
    WHEN incident."kind"::text = 'BLOCKED_AUTH' THEN 'AUTH'::"CourseSupportFailureClass"
    ELSE 'UNKNOWN'::"CourseSupportFailureClass"
  END,
  "nextAttemptAt" = CASE
    WHEN incident."status"::text = 'AUTO_INVESTIGATING' THEN CURRENT_TIMESTAMP
    ELSE NULL
  END
FROM "Course" AS course
WHERE course."id" = incident."courseId";

UPDATE "CourseSupportIncident"
SET "failureFingerprint" = md5(
  "providerFamilyKey" || ':' || "failureClass"::text || ':' || "kind"::text
);

UPDATE "CourseSupportIncident" AS incident
SET
  "activeRealSearchCount" = demand."activeCount",
  "affectedSearchCount" = GREATEST(incident."affectedSearchCount", demand."activeCount"),
  "earliestTargetDate" = demand."earliestDate",
  "engineeringOnly" = CASE WHEN demand."activeCount" > 0 THEN false ELSE incident."engineeringOnly" END
FROM (
  SELECT
    preference."courseId",
    COUNT(DISTINCT search."id")::INTEGER AS "activeCount",
    MIN(search."date") AS "earliestDate"
  FROM "CoursePreference" AS preference
  INNER JOIN "TeeSearch" AS search ON search."id" = preference."teeSearchId"
  WHERE
    search."status" = 'ACTIVE'
    AND search."date" >= date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
    AND search."trafficClass" NOT IN ('AUTOMATION', 'TEST')
  GROUP BY preference."courseId"
) AS demand
WHERE demand."courseId" = incident."courseId";

CREATE TABLE "CourseSupportBatch" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "providerFamilyKey" TEXT NOT NULL,
  "failureFingerprint" TEXT NOT NULL,
  "status" "CourseSupportBatchStatus" NOT NULL DEFAULT 'CLAIMED',
  "ownerAutomationRunId" TEXT,
  "ownerThreadId" TEXT,
  "leaseToken" TEXT NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "heartbeatAt" TIMESTAMP(3) NOT NULL,
  "baseSha" TEXT NOT NULL,
  "releaseSha" TEXT,
  "deployedAt" TIMESTAMP(3),
  "recheckDispatchKey" TEXT,
  "recheckDispatchStartedAt" TIMESTAMP(3),
  "recheckDispatchedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "maxCourses" INTEGER NOT NULL DEFAULT 5,
  "summary" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourseSupportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseSupportBatchIncident" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "incidentId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "cycle" INTEGER NOT NULL,
  "result" "CourseSupportBatchIncidentResult" NOT NULL DEFAULT 'PENDING',
  "preProbeId" TEXT,
  "postProbeId" TEXT,
  "message" TEXT,
  "proofSnapshot" JSONB,
  "verifiedIncidentUpdatedAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourseSupportBatchIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseSupportBatchSearch" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "teeSearchId" TEXT,
  "searchRef" TEXT NOT NULL,
  "scheduleVersion" INTEGER NOT NULL,
  "removedAt" TIMESTAMP(3),
  "removalReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourseSupportBatchSearch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderRequestLease" (
  "providerFamilyKey" TEXT NOT NULL,
  "slot" INTEGER NOT NULL,
  "leaseToken" TEXT NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ProviderRequestLease_pkey" PRIMARY KEY ("providerFamilyKey", "slot")
);

ALTER TABLE "CourseSupportBatch"
  ADD CONSTRAINT "CourseSupportBatch_ownerAutomationRunId_fkey"
  FOREIGN KEY ("ownerAutomationRunId") REFERENCES "AutomationRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CourseSupportBatchIncident"
  ADD CONSTRAINT "CourseSupportBatchIncident_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "CourseSupportBatch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CourseSupportBatchIncident"
  ADD CONSTRAINT "CourseSupportBatchIncident_incidentId_fkey"
  FOREIGN KEY ("incidentId") REFERENCES "CourseSupportIncident"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CourseSupportBatchIncident"
  ADD CONSTRAINT "CourseSupportBatchIncident_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CourseSupportBatchSearch"
  ADD CONSTRAINT "CourseSupportBatchSearch_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "CourseSupportBatch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CourseSupportBatchSearch"
  ADD CONSTRAINT "CourseSupportBatchSearch_teeSearchId_fkey"
  FOREIGN KEY ("teeSearchId") REFERENCES "TeeSearch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CourseSupportIncident"
  ADD CONSTRAINT "CourseSupportIncident_activeBatchId_fkey"
  FOREIGN KEY ("activeBatchId") REFERENCES "CourseSupportBatch"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Course_providerFamilyKey_automationEligibility_idx"
  ON "Course"("providerFamilyKey", "automationEligibility");
CREATE INDEX "TeeSearch_checkLeaseExpiresAt_idx" ON "TeeSearch"("checkLeaseExpiresAt");
CREATE INDEX "CourseSupportIncident_status_nextAttemptAt_idx"
  ON "CourseSupportIncident"("status", "nextAttemptAt");
CREATE INDEX "CourseSupportIncident_providerFamilyKey_failureFingerprint_status_idx"
  ON "CourseSupportIncident"("providerFamilyKey", "failureFingerprint", "status");
CREATE INDEX "CourseSupportIncident_activeBatchId_idx"
  ON "CourseSupportIncident"("activeBatchId");
CREATE INDEX "CourseSupportBatch_status_leaseExpiresAt_idx"
  ON "CourseSupportBatch"("status", "leaseExpiresAt");
CREATE INDEX "CourseSupportBatch_providerFamilyKey_failureFingerprint_createdAt_idx"
  ON "CourseSupportBatch"("providerFamilyKey", "failureFingerprint", "createdAt");
CREATE INDEX "CourseSupportBatch_ownerAutomationRunId_idx"
  ON "CourseSupportBatch"("ownerAutomationRunId");
CREATE UNIQUE INDEX "CourseSupportBatch_reference_key"
  ON "CourseSupportBatch"("reference");
CREATE UNIQUE INDEX "CourseSupportBatch_active_family_fingerprint_key"
  ON "CourseSupportBatch"("providerFamilyKey", "failureFingerprint")
  WHERE "status" IN ('CLAIMED', 'IMPLEMENTING', 'VERIFYING');
CREATE UNIQUE INDEX "CourseSupportBatch_single_active_key"
  ON "CourseSupportBatch" ((true))
  WHERE "status" IN ('CLAIMED', 'IMPLEMENTING', 'VERIFYING');
CREATE UNIQUE INDEX "CourseSupportBatchIncident_batchId_incidentId_key"
  ON "CourseSupportBatchIncident"("batchId", "incidentId");
CREATE INDEX "CourseSupportBatchIncident_incidentId_idx"
  ON "CourseSupportBatchIncident"("incidentId");
CREATE INDEX "CourseSupportBatchIncident_courseId_idx"
  ON "CourseSupportBatchIncident"("courseId");
CREATE INDEX "CourseSupportBatchIncident_result_updatedAt_idx"
  ON "CourseSupportBatchIncident"("result", "updatedAt");
CREATE UNIQUE INDEX "CourseSupportBatchSearch_batchId_searchRef_key"
  ON "CourseSupportBatchSearch"("batchId", "searchRef");
CREATE INDEX "CourseSupportBatchSearch_teeSearchId_idx"
  ON "CourseSupportBatchSearch"("teeSearchId");
CREATE INDEX "CourseSupportBatchSearch_batchId_removedAt_idx"
  ON "CourseSupportBatchSearch"("batchId", "removedAt");
CREATE INDEX "ProviderRequestLease_leaseExpiresAt_idx"
  ON "ProviderRequestLease"("leaseExpiresAt");
