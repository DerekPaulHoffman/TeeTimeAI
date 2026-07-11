ALTER TABLE "Course"
ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'America/New_York';

ALTER TABLE "TeeSearch"
ADD COLUMN "userTimeZone" TEXT NOT NULL DEFAULT 'America/New_York';
