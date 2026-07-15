ALTER TABLE "Course"
ADD COLUMN "par" INTEGER,
ADD COLUMN "parEvidenceUrl" TEXT,
ADD COLUMN "parVerifiedAt" TIMESTAMP(3);

ALTER TABLE "Course"
ADD CONSTRAINT "Course_par_supported_check"
CHECK ("par" IS NULL OR "par" BETWEEN 27 AND 90),
ADD CONSTRAINT "Course_par_verified_check"
CHECK ("par" IS NULL OR "parVerifiedAt" IS NOT NULL);

UPDATE "Course"
SET
  "layoutHoleCounts" = ARRAY[18]::INTEGER[],
  "layoutHolesEvidenceUrl" = 'https://www.traditionatoaklane.com/course',
  "layoutHolesVerifiedAt" = TIMESTAMP '2026-07-15 16:00:00',
  "par" = 72,
  "parEvidenceUrl" = 'https://www.traditionatoaklane.com/course',
  "parVerifiedAt" = TIMESTAMP '2026-07-15 16:00:00'
WHERE "googlePlaceId" = 'ChIJExAgjx_f54kROzCYBnwhxwo';
