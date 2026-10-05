-- A match keeps the exact simulator source configuration that produced it.
-- Outdoor and historical matches remain nullable and retain their identities.
ALTER TABLE "TeeTimeMatch" ADD COLUMN "offeringSourceFingerprint" TEXT;
