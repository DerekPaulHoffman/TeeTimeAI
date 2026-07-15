-- Complete only pre-deployment synthetic searches that already produced probe evidence.
-- New default synthetic searches are completed by the workflow after their first
-- successful check; explicit multi-cycle searches and customer demand are excluded.
UPDATE "TeeSearch" AS search
SET
  "status" = 'COMPLETED',
  "checkStatus" = 'STOPPED',
  "nextCheckAt" = NULL,
  "lastCheckOutcome" = concat_ws(
    '; ',
    NULLIF(search."lastCheckOutcome", ''),
    'legacy synthetic one-check complete'
  ),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE search."trafficClass" IN ('TEST', 'AUTOMATION')
  AND search."syntheticMultiCycle" = false
  AND search."status" = 'ACTIVE'
  AND search."createdAt" < TIMESTAMPTZ '2026-07-15 04:12:53+00'
  AND search."lastCheckOutcome" NOT LIKE '%legacy synthetic one-check complete%'
  AND EXISTS (
    SELECT 1
    FROM "CourseProbe" AS probe
    WHERE probe."teeSearchId" = search."id"
  );
