-- Add a separate rental offering under each existing physical venue. Existing
-- searches retain their outdoor mode and their established uniqueness keys.
CREATE TYPE "SearchMode" AS ENUM ('OUTDOOR', 'SIMULATOR');
CREATE TYPE "OfferingPublicAccessStatus" AS ENUM ('PUBLIC', 'UNVERIFIED', 'NOT_PUBLIC');
CREATE TYPE "OfferingMonitoringState" AS ENUM (
  'UNKNOWN', 'VERIFYING', 'HEALTHY', 'DEGRADED_RETRYING', 'FINAL_TECHNICAL', 'FINAL_IDENTITY'
);

ALTER TABLE "TeeSearch"
  ADD COLUMN "mode" "SearchMode" NOT NULL DEFAULT 'OUTDOOR',
  ADD COLUMN "durationMinutes" INTEGER;

CREATE TABLE "CourseOffering" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "kind" "SearchMode" NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "publicAccessStatus" "OfferingPublicAccessStatus" NOT NULL DEFAULT 'UNVERIFIED',
  "bookingUrl" TEXT,
  "evidenceUrl" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "providerFamilyKey" TEXT,
  "providerMetadata" JSONB,
  "maxPartySize" INTEGER,
  "supportedDurationsMinutes" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  "bookingWindowDaysAhead" INTEGER,
  "bookingReleaseTimeLocal" TEXT,
  "monitoringMode" "CourseMonitoringMode" NOT NULL DEFAULT 'AUTOMATIC',
  "automationEligibility" "AutomationEligibility" NOT NULL DEFAULT 'UNKNOWN',
  "monitoringState" "OfferingMonitoringState" NOT NULL DEFAULT 'UNKNOWN',
  "monitoringVerifiedAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "observationToken" TEXT,
  "observationExpiresAt" TIMESTAMP(3),
  "monitoringRevision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourseOffering_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseOffering_courseId_kind_key" ON "CourseOffering"("courseId", "kind");
CREATE INDEX "CourseOffering_kind_active_publicAccessStatus_idx" ON "CourseOffering"("kind", "active", "publicAccessStatus");
CREATE INDEX "CourseOffering_kind_monitoringState_idx" ON "CourseOffering"("kind", "monitoringState");
ALTER TABLE "CourseOffering" ADD CONSTRAINT "CourseOffering_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing Course facts retain outdoor semantics. The offering row gives
-- historical preferences, probes, and matches a precise outdoor reference.
INSERT INTO "CourseOffering" (
  "id", "courseId", "kind", "publicAccessStatus", "bookingUrl",
  "providerFamilyKey", "bookingWindowDaysAhead", "bookingReleaseTimeLocal",
  "monitoringMode", "automationEligibility", "createdAt", "updatedAt"
)
SELECT
  'outdoor-' || "id", "id", 'OUTDOOR',
  CASE WHEN "isPublic" IS TRUE THEN 'PUBLIC'::"OfferingPublicAccessStatus"
       WHEN "isPublic" IS FALSE THEN 'NOT_PUBLIC'::"OfferingPublicAccessStatus"
       ELSE 'UNVERIFIED'::"OfferingPublicAccessStatus" END,
  "detectedBookingUrl", "providerFamilyKey", "bookingWindowDaysAhead",
  "bookingReleaseTimeLocal", "monitoringMode", "automationEligibility",
  "createdAt", CURRENT_TIMESTAMP
FROM "Course";

ALTER TABLE "CoursePreference" ADD COLUMN "offeringId" TEXT;
ALTER TABLE "CourseProbe" ADD COLUMN "offeringId" TEXT;
ALTER TABLE "TeeTimeMatch"
  ADD COLUMN "offeringId" TEXT,
  ADD COLUMN "endsAt" TIMESTAMP(3),
  ADD COLUMN "resourceId" TEXT,
  ADD COLUMN "productId" TEXT,
  ADD COLUMN "priceBasis" TEXT,
  ADD COLUMN "currency" TEXT,
  ADD COLUMN "capacity" INTEGER;

UPDATE "CoursePreference" SET "offeringId" = 'outdoor-' || "courseId";
UPDATE "CourseProbe" SET "offeringId" = 'outdoor-' || "courseId";
UPDATE "TeeTimeMatch" SET "offeringId" = 'outdoor-' || "courseId";

CREATE INDEX "TeeSearch_mode_status_nextCheckAt_idx" ON "TeeSearch"("mode", "status", "nextCheckAt");
CREATE INDEX "CoursePreference_offeringId_idx" ON "CoursePreference"("offeringId");
CREATE INDEX "CourseProbe_offeringId_observedAt_idx" ON "CourseProbe"("offeringId", "observedAt");
CREATE INDEX "TeeTimeMatch_offeringId_startsAt_idx" ON "TeeTimeMatch"("offeringId", "startsAt");

ALTER TABLE "CoursePreference" ADD CONSTRAINT "CoursePreference_offeringId_fkey"
  FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CourseProbe" ADD CONSTRAINT "CourseProbe_offeringId_fkey"
  FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TeeTimeMatch" ADD CONSTRAINT "TeeTimeMatch_offeringId_fkey"
  FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SimulatorSupportIncident" (
  "id" TEXT NOT NULL,
  "offeringId" TEXT NOT NULL,
  "status" "CourseSupportIncidentStatus" NOT NULL DEFAULT 'AUTO_INVESTIGATING',
  "reason" TEXT,
  "evidenceUrl" TEXT,
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "resolvedAt" TIMESTAMP(3),
  "retryAt" TIMESTAMP(3),
  CONSTRAINT "SimulatorSupportIncident_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SimulatorSupportIncident_offeringId_key" ON "SimulatorSupportIncident"("offeringId");
CREATE INDEX "SimulatorSupportIncident_status_firstSeenAt_idx" ON "SimulatorSupportIncident"("status", "firstSeenAt");
ALTER TABLE "SimulatorSupportIncident" ADD CONSTRAINT "SimulatorSupportIncident_offeringId_fkey"
  FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE CASCADE ON UPDATE CASCADE;
