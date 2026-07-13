CREATE TYPE "BookingWindowSource" AS ENUM (
  'PROVIDER_CONFIG',
  'PROVIDER_MESSAGE',
  'OFFICIAL_BOOKING_PAGE'
);

ALTER TABLE "Course"
ADD COLUMN "bookingWindowDaysAhead" INTEGER,
ADD COLUMN "bookingReleaseTimeLocal" TEXT,
ADD COLUMN "bookingWindowSource" "BookingWindowSource",
ADD COLUMN "bookingWindowConfidence" DOUBLE PRECISION,
ADD COLUMN "bookingWindowEvidenceUrl" TEXT,
ADD COLUMN "bookingWindowCheckedAt" TIMESTAMP(3),
ADD COLUMN "bookingWindowObservedAt" TIMESTAMP(3);
