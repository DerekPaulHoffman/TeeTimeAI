ALTER TABLE "Course"
ADD COLUMN "observedInventoryHorizonDaysAhead" INTEGER,
ADD COLUMN "observedInventoryHorizonConfidence" DOUBLE PRECISION,
ADD COLUMN "observedInventoryHorizonSampleCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "observedInventoryHorizonObservedAt" TIMESTAMP(3);

CREATE TABLE "CourseInventoryHorizonObservation" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "observedLocalDate" DATE NOT NULL,
    "inventoryThroughDate" DATE NOT NULL,
    "daysAhead" INTEGER NOT NULL,
    "trailingUnavailableDays" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "evidenceUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseInventoryHorizonObservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseInventoryHorizonObservation_courseId_observedLocalDate_key"
ON "CourseInventoryHorizonObservation"("courseId", "observedLocalDate");

CREATE INDEX "CourseInventoryHorizonObservation_courseId_observedAt_idx"
ON "CourseInventoryHorizonObservation"("courseId", "observedAt");

CREATE INDEX "CourseInventoryHorizonObservation_observedAt_idx"
ON "CourseInventoryHorizonObservation"("observedAt");

ALTER TABLE "CourseInventoryHorizonObservation"
ADD CONSTRAINT "CourseInventoryHorizonObservation_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
