CREATE TYPE "BookingAccessMode" AS ENUM (
  'UNKNOWN',
  'PUBLIC_SIGNED_OUT',
  'ACCOUNT_REQUIRED',
  'ACCOUNT_SELF_SERVICE',
  'ACCOUNT_STAFF_PROVISIONED',
  'PHONE_ONLY',
  'CONTACT_COURSE',
  'WALK_IN',
  'CAPTCHA_OR_QUEUE'
);

ALTER TABLE "Course"
ADD COLUMN "bookingAccessMode" "BookingAccessMode" NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE "CourseAutomationDiscovery"
ADD COLUMN "bookingAccessMode" "BookingAccessMode" NOT NULL DEFAULT 'UNKNOWN';

UPDATE "Course"
SET "bookingAccessMode" = CASE
  WHEN "automationEligibility" = 'ALLOWED' THEN 'PUBLIC_SIGNED_OUT'::"BookingAccessMode"
  WHEN "automationReason" = 'ACCOUNT_REQUIRED' THEN 'ACCOUNT_REQUIRED'::"BookingAccessMode"
  WHEN "automationReason" = 'CAPTCHA_OR_QUEUE' THEN 'CAPTCHA_OR_QUEUE'::"BookingAccessMode"
  WHEN "bookingMethod" = 'PHONE_ONLY' THEN 'PHONE_ONLY'::"BookingAccessMode"
  WHEN "bookingMethod" = 'CONTACT_COURSE' THEN 'CONTACT_COURSE'::"BookingAccessMode"
  WHEN "bookingMethod" = 'WALK_IN' THEN 'WALK_IN'::"BookingAccessMode"
  ELSE 'UNKNOWN'::"BookingAccessMode"
END;

UPDATE "CourseAutomationDiscovery"
SET "bookingAccessMode" = CASE
  WHEN "automationEligibility" = 'ALLOWED' THEN 'PUBLIC_SIGNED_OUT'::"BookingAccessMode"
  WHEN "automationReason" = 'ACCOUNT_REQUIRED' THEN 'ACCOUNT_REQUIRED'::"BookingAccessMode"
  WHEN "automationReason" = 'CAPTCHA_OR_QUEUE' THEN 'CAPTCHA_OR_QUEUE'::"BookingAccessMode"
  WHEN "bookingMethod" = 'PHONE_ONLY' THEN 'PHONE_ONLY'::"BookingAccessMode"
  WHEN "bookingMethod" = 'CONTACT_COURSE' THEN 'CONTACT_COURSE'::"BookingAccessMode"
  WHEN "bookingMethod" = 'WALK_IN' THEN 'WALK_IN'::"BookingAccessMode"
  ELSE 'UNKNOWN'::"BookingAccessMode"
END;
