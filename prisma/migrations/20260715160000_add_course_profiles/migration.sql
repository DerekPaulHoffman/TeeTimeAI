CREATE TYPE "CourseProfileStatus" AS ENUM ('PENDING', 'PUBLISHED', 'BLOCKED_EVIDENCE', 'STALE');
CREATE TYPE "CourseProfileType" AS ENUM ('MUNICIPAL', 'DAILY_FEE', 'RESORT', 'UNIVERSITY', 'MILITARY', 'SEMI_PRIVATE', 'OTHER_PUBLIC');
CREATE TYPE "CourseProfileSourceType" AS ENUM ('OFFICIAL_COURSE', 'OFFICIAL_OPERATOR', 'MUNICIPAL_GOVERNMENT', 'OFFICIAL_BOOKING', 'GOLF_ASSOCIATION', 'GOVERNMENT_TOURISM', 'ESTABLISHED_NEWS', 'GOOGLE_PLACE_IDENTITY');

ALTER TABLE "Course"
ADD COLUMN "city" TEXT,
ADD COLUMN "stateCode" TEXT,
ADD COLUMN "stateName" TEXT,
ADD COLUMN "county" TEXT,
ADD COLUMN "countryCode" TEXT;

CREATE TABLE "CourseProfile" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "canonicalSlug" TEXT NOT NULL,
  "status" "CourseProfileStatus" NOT NULL DEFAULT 'PENDING',
  "courseType" "CourseProfileType",
  "accessSummary" TEXT,
  "overview" TEXT,
  "courseCharacter" TEXT,
  "notableFacts" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "contentHash" TEXT,
  "contentVersion" INTEGER NOT NULL DEFAULT 1,
  "profileVerifiedAt" TIMESTAMP(3),
  "reviewDueAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "lastResearchAttemptAt" TIMESTAMP(3),
  "lastRefreshedAt" TIMESTAMP(3),
  "failedResearchAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourseProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseProfileSource" (
  "id" TEXT NOT NULL,
  "courseProfileId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "publisher" TEXT NOT NULL,
  "sourceType" "CourseProfileSourceType" NOT NULL,
  "claimKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "evidenceSummary" TEXT NOT NULL,
  "accessedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CourseProfileSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CourseProfileSlugAlias" (
  "id" TEXT NOT NULL,
  "courseProfileId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourseProfileSlugAlias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseProfile_courseId_key" ON "CourseProfile"("courseId");
CREATE UNIQUE INDEX "CourseProfile_canonicalSlug_key" ON "CourseProfile"("canonicalSlug");
CREATE INDEX "CourseProfile_status_reviewDueAt_idx" ON "CourseProfile"("status", "reviewDueAt");
CREATE INDEX "CourseProfile_publishedAt_idx" ON "CourseProfile"("publishedAt");
CREATE UNIQUE INDEX "CourseProfileSource_courseProfileId_url_key" ON "CourseProfileSource"("courseProfileId", "url");
CREATE INDEX "CourseProfileSource_courseProfileId_sourceType_idx" ON "CourseProfileSource"("courseProfileId", "sourceType");
CREATE UNIQUE INDEX "CourseProfileSlugAlias_slug_key" ON "CourseProfileSlugAlias"("slug");
CREATE INDEX "CourseProfileSlugAlias_courseProfileId_idx" ON "CourseProfileSlugAlias"("courseProfileId");
CREATE INDEX "Course_stateCode_county_automationEligibility_idx" ON "Course"("stateCode", "county", "automationEligibility");

ALTER TABLE "CourseProfile" ADD CONSTRAINT "CourseProfile_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourseProfileSource" ADD CONSTRAINT "CourseProfileSource_courseProfileId_fkey" FOREIGN KEY ("courseProfileId") REFERENCES "CourseProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CourseProfileSlugAlias" ADD CONSTRAINT "CourseProfileSlugAlias_courseProfileId_fkey" FOREIGN KEY ("courseProfileId") REFERENCES "CourseProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "mark_course_profile_stale_on_material_course_change"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."name" IS DISTINCT FROM NEW."name"
    OR OLD."googlePlaceId" IS DISTINCT FROM NEW."googlePlaceId"
    OR OLD."address" IS DISTINCT FROM NEW."address"
    OR OLD."city" IS DISTINCT FROM NEW."city"
    OR OLD."stateCode" IS DISTINCT FROM NEW."stateCode"
    OR OLD."stateName" IS DISTINCT FROM NEW."stateName"
    OR OLD."county" IS DISTINCT FROM NEW."county"
    OR OLD."countryCode" IS DISTINCT FROM NEW."countryCode"
    OR OLD."website" IS DISTINCT FROM NEW."website"
    OR OLD."detectedBookingUrl" IS DISTINCT FROM NEW."detectedBookingUrl"
    OR OLD."isPublic" IS DISTINCT FROM NEW."isPublic"
    OR OLD."automationEligibility" IS DISTINCT FROM NEW."automationEligibility"
  THEN
    UPDATE "CourseProfile"
    SET "status" = 'STALE', "reviewDueAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "courseId" = NEW."id" AND "status" = 'PUBLISHED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Course_profile_material_change_trigger"
AFTER UPDATE ON "Course"
FOR EACH ROW
EXECUTE FUNCTION "mark_course_profile_stale_on_material_course_change"();

ALTER TABLE "CourseProfile"
ADD CONSTRAINT "CourseProfile_published_content_check"
CHECK (
  "status" <> 'PUBLISHED'
  OR (
    "courseType" IS NOT NULL
    AND "accessSummary" IS NOT NULL
    AND "overview" IS NOT NULL
    AND "courseCharacter" IS NOT NULL
    AND "profileVerifiedAt" IS NOT NULL
    AND "reviewDueAt" IS NOT NULL
    AND "publishedAt" IS NOT NULL
  )
);
