-- CreateEnum
CREATE TYPE "BookingMethod" AS ENUM (
  'UNKNOWN',
  'PUBLIC_ONLINE',
  'PHONE_ONLY',
  'ONLINE_OR_PHONE',
  'CONTACT_COURSE',
  'WALK_IN'
);

-- CreateEnum
CREATE TYPE "AutomationReason" AS ENUM (
  'NONE',
  'NO_ONLINE_BOOKING',
  'UNSUPPORTED_PLATFORM',
  'AUTOMATION_PROHIBITED',
  'ACCOUNT_REQUIRED',
  'CAPTCHA_OR_QUEUE',
  'TEMPORARILY_UNAVAILABLE',
  'OTHER'
);

-- AlterTable
ALTER TABLE "Course"
ADD COLUMN "bookingMethod" "BookingMethod" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "bookingPhone" TEXT,
ADD COLUMN "automationReason" "AutomationReason" NOT NULL DEFAULT 'NONE',
ADD COLUMN "intelligenceVerifiedAt" TIMESTAMP(3),
ADD COLUMN "intelligenceReviewAt" TIMESTAMP(3),
ADD COLUMN "intelligenceConfidence" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "CourseAutomationDiscovery"
ADD COLUMN "bookingMethod" "BookingMethod" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "bookingPhone" TEXT,
ADD COLUMN "automationEligibility" "AutomationEligibility" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "automationReason" "AutomationReason" NOT NULL DEFAULT 'NONE';

-- Backfill currently supported online courses from durable adapter metadata.
UPDATE "Course"
SET
  "bookingMethod" = 'PUBLIC_ONLINE',
  "automationReason" = 'NONE',
  "intelligenceVerifiedAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP),
  "intelligenceConfidence" = 1
WHERE
  "automationEligibility" = 'ALLOWED'
  AND "detectedBookingUrl" IS NOT NULL;

-- Backfill the verified Fairview Farm phone-only finding.
UPDATE "Course"
SET
  "bookingMethod" = 'PHONE_ONLY',
  "bookingPhone" = COALESCE("phone", '(860) 689-1000'),
  "automationReason" = 'NO_ONLINE_BOOKING',
  "intelligenceVerifiedAt" = TIMESTAMP '2026-07-10 08:32:00',
  "intelligenceReviewAt" = CURRENT_TIMESTAMP + INTERVAL '90 days',
  "intelligenceConfidence" = 1
WHERE
  "googlePlaceId" = 'ChIJUxXC6FC954kRNeihTcYdptA'
  OR LOWER("name") = 'fairview farm golf course';

-- Preserve the structured Fairview finding in the append-only evidence history.
INSERT INTO "CourseAutomationDiscovery" (
  "id",
  "courseId",
  "status",
  "detectedPlatform",
  "bookingMethod",
  "bookingPhone",
  "automationEligibility",
  "automationReason",
  "sourceUrl",
  "confidence",
  "evidence",
  "createdAt"
)
SELECT
  'course-intelligence-fairview-phone-only-' || "id",
  "id",
  'VERIFIED',
  "detectedPlatform",
  'PHONE_ONLY',
  COALESCE("phone", '(860) 689-1000'),
  'BLOCKED',
  'NO_ONLINE_BOOKING',
  COALESCE("website", 'https://fairviewfarmgc.com/'),
  1,
  jsonb_build_object(
    'learnedFrom', 'official-site-research',
    'officialSources', jsonb_build_array(
      'https://fairviewfarmgc.com/',
      'https://fairviewfarmgc.com/golf/'
    ),
    'finding', 'Official pages direct golfers to phone booking and expose no public online tee sheet.'
  ),
  CURRENT_TIMESTAMP
FROM "Course"
WHERE
  "googlePlaceId" = 'ChIJUxXC6FC954kRNeihTcYdptA'
  OR LOWER("name") = 'fairview farm golf course';

-- CreateIndex
CREATE INDEX "Course_bookingMethod_automationEligibility_idx"
ON "Course"("bookingMethod", "automationEligibility");

-- CreateIndex
CREATE INDEX "Course_intelligenceReviewAt_idx"
ON "Course"("intelligenceReviewAt");

-- CreateIndex
CREATE INDEX "CourseAutomationDiscovery_bookingMethod_createdAt_idx"
ON "CourseAutomationDiscovery"("bookingMethod", "createdAt");
