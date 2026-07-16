-- A tee time can disappear and later reopen. Each confirmed reopening needs a
-- distinct delivery identity so the earlier email group cannot suppress it.
ALTER TABLE "TeeTimeMatch"
ADD COLUMN "availabilityCycle" INTEGER NOT NULL DEFAULT 0;

-- TeeSnap historically used the front/back tee-off section in the source id,
-- which produced two customer-visible matches for one start time. Preserve the
-- best existing row as the canonical section-independent slot before the new
-- adapter starts emitting that key. This prevents a one-time duplicate alert
-- during rollout while retaining sent history on the retired rows.
CREATE TEMP TABLE "_TeeSnapCanonicalMatches" AS
SELECT
  candidate."id",
  candidate."canonicalSourceId",
  candidate."rowNumber"
FROM (
  SELECT
    slot."id",
    regexp_replace(
      slot."sourceId",
      '-(FRONT_NINE|BACK_NINE|tee)$',
      ''
    ) AS "canonicalSourceId",
    row_number() OVER (
      PARTITION BY slot."teeSearchId", slot."courseId", slot."startsAt"
      ORDER BY
        CASE slot."alertStatus"
          WHEN 'SENT' THEN 0
          WHEN 'PENDING' THEN 1
          ELSE 2
        END,
        CASE slot."availabilityStatus"
          WHEN 'AVAILABLE' THEN 0
          ELSE 1
        END,
        slot."lastConfirmedAt" DESC,
        slot."id"
    ) AS "rowNumber"
  FROM "TeeTimeMatch" AS slot
  WHERE slot."sourceId" ~ '^teesnap-.*-(FRONT_NINE|BACK_NINE|tee)$'
    AND NOT EXISTS (
      SELECT 1
      FROM "TeeTimeMatch" AS canonical
      WHERE canonical."teeSearchId" = slot."teeSearchId"
        AND canonical."courseId" = slot."courseId"
        AND canonical."startsAt" = slot."startsAt"
        AND canonical."sourceId" = regexp_replace(
          slot."sourceId",
          '-(FRONT_NINE|BACK_NINE|tee)$',
          ''
        )
    )
) AS candidate;

UPDATE "TeeTimeMatch" AS match
SET
  "availabilityStatus" = 'GONE',
  "unavailableAt" = COALESCE(match."unavailableAt", CURRENT_TIMESTAMP),
  "alertStatus" = CASE
    WHEN match."alertStatus" = 'PENDING' THEN 'SUPPRESSED'
    ELSE match."alertStatus"
  END,
  "sentAt" = CASE
    WHEN match."alertStatus" = 'PENDING'
      THEN COALESCE(match."sentAt", CURRENT_TIMESTAMP)
    ELSE match."sentAt"
  END
FROM "_TeeSnapCanonicalMatches" AS candidate
WHERE match."id" = candidate."id"
  AND candidate."rowNumber" > 1;

UPDATE "TeeTimeMatch" AS match
SET "sourceId" = candidate."canonicalSourceId"
FROM "_TeeSnapCanonicalMatches" AS candidate
WHERE match."id" = candidate."id"
  AND candidate."rowNumber" = 1;

DROP TABLE "_TeeSnapCanonicalMatches";
