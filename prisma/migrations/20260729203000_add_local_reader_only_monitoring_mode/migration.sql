CREATE TYPE "CourseMonitoringMode" AS ENUM ('AUTOMATIC', 'LOCAL_READER_ONLY');

ALTER TABLE "Course"
ADD COLUMN "monitoringMode" "CourseMonitoringMode" NOT NULL DEFAULT 'AUTOMATIC';

UPDATE "Course"
SET "monitoringMode" = 'LOCAL_READER_ONLY'
WHERE "detectedBookingUrl" ~ '^https://secure\.east\.prophetservices\.com/FrearParkV3(?:/|$)';

CREATE INDEX "Course_monitoringMode_idx" ON "Course"("monitoringMode");
