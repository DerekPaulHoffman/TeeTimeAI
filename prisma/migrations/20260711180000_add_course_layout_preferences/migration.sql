-- Store verified physical course layouts independently from purchasable round lengths.
ALTER TABLE "Course"
ADD COLUMN "layoutHoleCounts" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN "layoutHolesEvidenceUrl" TEXT,
ADD COLUMN "layoutHolesVerifiedAt" TIMESTAMP(3);

ALTER TABLE "Course"
ADD CONSTRAINT "Course_layoutHoleCounts_supported_check"
CHECK ("layoutHoleCounts" <@ ARRAY[9, 18]::INTEGER[]),
ADD CONSTRAINT "Course_layoutHoleCounts_size_check"
CHECK (cardinality("layoutHoleCounts") <= 2),
ADD CONSTRAINT "Course_layoutHoleCounts_verified_check"
CHECK (cardinality("layoutHoleCounts") = 0 OR "layoutHolesVerifiedAt" IS NOT NULL);

-- The search preference describes physical course layout. It does not filter tee-sheet round length.
ALTER TABLE "TeeSearch"
ADD COLUMN "requestedLayoutHoles" INTEGER,
ADD CONSTRAINT "TeeSearch_requestedLayoutHoles_supported_check"
CHECK ("requestedLayoutHoles" IS NULL OR "requestedLayoutHoles" IN (9, 18));

-- Woodhaven is a verified nine-hole physical course, even though it offers an 18-hole rate.
UPDATE "Course" AS target
SET
  "googlePlaceId" = CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM "Course" AS exact_course
      WHERE
        exact_course."googlePlaceId" = 'ChIJUypX_OHc54kRkpGKTvmSvSA'
        AND exact_course."id" <> target."id"
    ) THEN 'ChIJUypX_OHc54kRkpGKTvmSvSA'
    ELSE target."googlePlaceId"
  END,
  "layoutHoleCounts" = ARRAY[9]::INTEGER[],
  "layoutHolesEvidenceUrl" = 'https://www.woodhavenctgolf.com/',
  "layoutHolesVerifiedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE
  target."googlePlaceId" = 'ChIJUypX_OHc54kRkpGKTvmSvSA'
  OR
  LOWER(target."name") IN (
    'woodhaven country club',
    'woodhaven golf course',
    'woodhaven country club & golf course'
  )
  OR LOWER(COALESCE(target."website", '')) LIKE '%woodhavenctgolf.com%';

INSERT INTO "Course" (
  "id",
  "googlePlaceId",
  "name",
  "address",
  "latitude",
  "longitude",
  "website",
  "phone",
  "layoutHoleCounts",
  "layoutHolesEvidenceUrl",
  "layoutHolesVerifiedAt",
  "updatedAt"
)
SELECT
  'verified-layout-woodhaven-country-club',
  'ChIJUypX_OHc54kRkpGKTvmSvSA',
  'Woodhaven Country Club',
  '275 Miller Road, Bethany, CT 06524',
  41.415596,
  -73.039627,
  'https://www.woodhavenctgolf.com/',
  '203-393-3230',
  ARRAY[9]::INTEGER[],
  'https://www.woodhavenctgolf.com/',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1
  FROM "Course"
  WHERE
    "googlePlaceId" = 'ChIJUypX_OHc54kRkpGKTvmSvSA'
    OR LOWER("name") IN (
      'woodhaven country club',
      'woodhaven golf course',
      'woodhaven country club & golf course'
    )
    OR LOWER(COALESCE("website", '')) LIKE '%woodhavenctgolf.com%'
);
