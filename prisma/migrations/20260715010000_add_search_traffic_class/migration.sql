-- Preserve the same aggregate traffic provenance used by WebsiteEvent on saved demand.
ALTER TABLE "TeeSearch"
ADD COLUMN "trafficClass" "WebsiteTrafficClass" NOT NULL DEFAULT 'UNCLASSIFIED';

CREATE INDEX "TeeSearch_trafficClass_status_date_idx"
ON "TeeSearch"("trafficClass", "status", "date");

-- Recover synthetic provenance only when a validated search_submitted event follows
-- the saved search and agrees on every low-cardinality submission dimension.
WITH "syntheticSubmissionMatch" AS (
  SELECT DISTINCT ON (search."id")
    search."id" AS "searchId",
    event."trafficClass"
  FROM "TeeSearch" AS search
  INNER JOIN "WebsiteEvent" AS event
    ON event."name" = 'search_submitted'
    AND event."trafficClass" IN ('AUTOMATION', 'TEST')
    AND event."createdAt" >= search."createdAt"
    AND event."createdAt" <= search."createdAt" + INTERVAL '15 seconds'
    AND (event."metadata"->>'players')::INTEGER = search."players"
    AND (event."metadata"->>'selectedCourseCount')::INTEGER = (
      SELECT COUNT(*)::INTEGER
      FROM "CoursePreference" AS preference
      WHERE preference."teeSearchId" = search."id"
    )
    AND (
      (event."metadata"->>'requestedLayoutHoles' IS NULL AND search."requestedLayoutHoles" IS NULL)
      OR (event."metadata"->>'requestedLayoutHoles')::INTEGER = search."requestedLayoutHoles"
    )
  ORDER BY search."id", event."createdAt" ASC
)
UPDATE "TeeSearch" AS search
SET "trafficClass" = matched."trafficClass"
FROM "syntheticSubmissionMatch" AS matched
WHERE search."id" = matched."searchId";
