ALTER TABLE "Course"
ADD COLUMN "ratingObservedAt" TIMESTAMP(3);

UPDATE "Course"
SET "ratingObservedAt" = "createdAt"
WHERE "rating" IS NOT NULL
  AND "ratingObservedAt" IS NULL;

CREATE TABLE "CourseBookingFact" (
  "courseId" TEXT NOT NULL,
  "holes" INTEGER NOT NULL,
  "minPriceCents" INTEGER,
  "maxPriceCents" INTEGER,
  "priceSampleSize" INTEGER,
  "priceObservedAt" TIMESTAMP(3),
  "bookableObservedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CourseBookingFact_pkey" PRIMARY KEY ("courseId", "holes"),
  CONSTRAINT "CourseBookingFact_holes_check" CHECK ("holes" IN (9, 18)),
  CONSTRAINT "CourseBookingFact_price_check" CHECK (
    (
      "minPriceCents" IS NULL
      AND "maxPriceCents" IS NULL
      AND "priceSampleSize" IS NULL
      AND "priceObservedAt" IS NULL
    )
    OR
    (
      "minPriceCents" IS NOT NULL
      AND "maxPriceCents" IS NOT NULL
      AND "priceSampleSize" IS NOT NULL
      AND "priceObservedAt" IS NOT NULL
      AND "minPriceCents" >= 0
      AND "maxPriceCents" >= "minPriceCents"
      AND "priceSampleSize" > 0
    )
  )
);

CREATE INDEX "CourseBookingFact_priceObservedAt_idx"
ON "CourseBookingFact"("priceObservedAt");

CREATE INDEX "CourseBookingFact_bookableObservedAt_idx"
ON "CourseBookingFact"("bookableObservedAt");

ALTER TABLE "CourseBookingFact"
ADD CONSTRAINT "CourseBookingFact_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "Course"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

WITH price_candidates AS (
  SELECT
    probe."courseId",
    hole_data.holes,
    (probe."rawSummary" -> 'pricing' -> hole_data.price_key ->> 'minPriceCents')::INTEGER AS min_price_cents,
    (probe."rawSummary" -> 'pricing' -> hole_data.price_key ->> 'maxPriceCents')::INTEGER AS max_price_cents,
    (probe."rawSummary" -> 'pricing' -> hole_data.price_key ->> 'sampleSize')::INTEGER AS sample_size,
    probe."observedAt" AS observed_at
  FROM "CourseProbe" probe
  CROSS JOIN (
    VALUES
      (9, 'nineHoles'),
      (18, 'eighteenHoles')
  ) AS hole_data(holes, price_key)
  WHERE jsonb_typeof(probe."rawSummary" -> 'pricing' -> hole_data.price_key) = 'object'
    AND jsonb_typeof(probe."rawSummary" -> 'pricing' -> hole_data.price_key -> 'minPriceCents') = 'number'
    AND jsonb_typeof(probe."rawSummary" -> 'pricing' -> hole_data.price_key -> 'maxPriceCents') = 'number'
    AND jsonb_typeof(probe."rawSummary" -> 'pricing' -> hole_data.price_key -> 'sampleSize') = 'number'
),
latest_prices AS (
  SELECT DISTINCT ON ("courseId", holes)
    "courseId",
    holes,
    min_price_cents,
    max_price_cents,
    sample_size,
    observed_at
  FROM price_candidates
  WHERE min_price_cents >= 0
    AND max_price_cents >= min_price_cents
    AND sample_size > 0
  ORDER BY "courseId", holes, observed_at DESC
)
INSERT INTO "CourseBookingFact" (
  "courseId",
  "holes",
  "minPriceCents",
  "maxPriceCents",
  "priceSampleSize",
  "priceObservedAt",
  "bookableObservedAt",
  "updatedAt"
)
SELECT
  "courseId",
  holes,
  min_price_cents,
  max_price_cents,
  sample_size,
  observed_at,
  observed_at,
  CURRENT_TIMESTAMP
FROM latest_prices
ON CONFLICT ("courseId", "holes") DO UPDATE
SET
  "minPriceCents" = EXCLUDED."minPriceCents",
  "maxPriceCents" = EXCLUDED."maxPriceCents",
  "priceSampleSize" = EXCLUDED."priceSampleSize",
  "priceObservedAt" = EXCLUDED."priceObservedAt",
  "bookableObservedAt" = GREATEST(
    "CourseBookingFact"."bookableObservedAt",
    EXCLUDED."bookableObservedAt"
  ),
  "updatedAt" = CURRENT_TIMESTAMP;

WITH probe_bookable_candidates AS (
  SELECT
    probe."courseId",
    value.holes::INTEGER AS holes,
    probe."observedAt" AS observed_at
  FROM "CourseProbe" probe
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE
      WHEN jsonb_typeof(probe."rawSummary" -> 'bookableHoleCounts') = 'array'
      THEN probe."rawSummary" -> 'bookableHoleCounts'
      ELSE '[]'::jsonb
    END
  ) AS value(holes)
  WHERE value.holes IN ('9', '18')
),
match_bookable_candidates AS (
  SELECT
    match."courseId",
    match."holes" AS holes,
    match."lastConfirmedAt" AS observed_at
  FROM "TeeTimeMatch" match
  WHERE match."holes" IN (9, 18)
),
latest_bookable AS (
  SELECT
    "courseId",
    holes,
    MAX(observed_at) AS observed_at
  FROM (
    SELECT * FROM probe_bookable_candidates
    UNION ALL
    SELECT * FROM match_bookable_candidates
  ) candidates
  GROUP BY "courseId", holes
)
INSERT INTO "CourseBookingFact" (
  "courseId",
  "holes",
  "bookableObservedAt",
  "updatedAt"
)
SELECT
  "courseId",
  holes,
  observed_at,
  CURRENT_TIMESTAMP
FROM latest_bookable
ON CONFLICT ("courseId", "holes") DO UPDATE
SET
  "bookableObservedAt" = GREATEST(
    "CourseBookingFact"."bookableObservedAt",
    EXCLUDED."bookableObservedAt"
  ),
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "CourseProfile"
SET
  "status" = 'STALE',
  "reviewDueAt" = COALESCE("reviewDueAt", CURRENT_TIMESTAMP),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'BLOCKED_EVIDENCE'
  AND "publishedAt" IS NOT NULL;
