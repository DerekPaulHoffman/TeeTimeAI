UPDATE "CourseBookingFact"
SET
  "minPriceCents" = NULL,
  "maxPriceCents" = NULL,
  "priceSampleSize" = NULL,
  "priceObservedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "courseId" = 'verified-layout-woodhaven-country-club'
  AND "holes" = 18
  AND "minPriceCents" = 50000
  AND "maxPriceCents" = 50000
  AND "priceSampleSize" = 1;
