CREATE TYPE "CourseSupportIncidentStatus" AS ENUM ('AUTO_INVESTIGATING', 'NEEDS_HUMAN', 'RESOLVED');

CREATE TYPE "CourseSupportIncidentKind" AS ENUM ('NEEDS_ADAPTER', 'FETCH_FAILED', 'BLOCKED_AUTH', 'BLOCKED_TOOLING');

CREATE TYPE "CourseSupportResolution" AS ENUM ('MONITORING_RESTORED', 'DIRECT_BOOKING_CLASSIFIED');

CREATE TABLE "CourseSupportIncident" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "firstAffectedSearchId" TEXT,
    "cycle" INTEGER NOT NULL DEFAULT 1,
    "status" "CourseSupportIncidentStatus" NOT NULL DEFAULT 'AUTO_INVESTIGATING',
    "kind" "CourseSupportIncidentKind" NOT NULL,
    "courseNameSnapshot" TEXT NOT NULL,
    "platformSnapshot" "DetectedPlatform" NOT NULL,
    "bookingUrlSnapshot" TEXT,
    "initialMessage" TEXT,
    "latestMessage" TEXT,
    "nextAction" TEXT,
    "affectedSearchCount" INTEGER NOT NULL DEFAULT 1,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ownerNotifiedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "escalationNotifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolution" "CourseSupportResolution",
    "resolutionMessage" TEXT,
    "resolutionNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseSupportIncident_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseSupportIncident_courseId_key" ON "CourseSupportIncident"("courseId");
CREATE INDEX "CourseSupportIncident_status_lastSeenAt_idx" ON "CourseSupportIncident"("status", "lastSeenAt");
CREATE INDEX "CourseSupportIncident_ownerNotifiedAt_idx" ON "CourseSupportIncident"("ownerNotifiedAt");
CREATE INDEX "CourseSupportIncident_resolutionNotifiedAt_idx" ON "CourseSupportIncident"("resolutionNotifiedAt");

ALTER TABLE "CourseSupportIncident"
ADD CONSTRAINT "CourseSupportIncident_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
