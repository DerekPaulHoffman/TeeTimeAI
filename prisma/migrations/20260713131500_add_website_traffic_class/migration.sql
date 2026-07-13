-- Additive classification only. Existing rows remain explicitly unclassified.
CREATE TYPE "WebsiteTrafficClass" AS ENUM ('UNCLASSIFIED', 'PUBLIC', 'AUTOMATION', 'TEST');

ALTER TABLE "WebsiteEvent"
ADD COLUMN "trafficClass" "WebsiteTrafficClass" NOT NULL DEFAULT 'UNCLASSIFIED';

ALTER TABLE "WebsiteFeedback"
ADD COLUMN "trafficClass" "WebsiteTrafficClass" NOT NULL DEFAULT 'UNCLASSIFIED';

CREATE INDEX "WebsiteEvent_trafficClass_createdAt_idx"
ON "WebsiteEvent"("trafficClass", "createdAt");

CREATE INDEX "WebsiteFeedback_trafficClass_createdAt_idx"
ON "WebsiteFeedback"("trafficClass", "createdAt");
