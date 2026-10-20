-- Immutable quota receipts retain their slot when a customer deletes a search.
CREATE TABLE "CourseDiscoveryPilotEnrollment" (
    "id" TEXT NOT NULL,
    "searchId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "cohortId" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CourseDiscoveryPilotEnrollment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CourseDiscoveryPilotEnrollment_slot_check" CHECK ("slot" BETWEEN 1 AND 3)
);

CREATE UNIQUE INDEX "CourseDiscoveryPilotEnrollment_searchId_key" ON "CourseDiscoveryPilotEnrollment"("searchId");
CREATE UNIQUE INDEX "CourseDiscoveryPilotEnrollment_cohortId_targetKey_key" ON "CourseDiscoveryPilotEnrollment"("cohortId", "targetKey");
CREATE UNIQUE INDEX "CourseDiscoveryPilotEnrollment_cohortId_slot_key" ON "CourseDiscoveryPilotEnrollment"("cohortId", "slot");
CREATE INDEX "CourseDiscoveryPilotEnrollment_ownerUserId_cohortId_createdAt_idx" ON "CourseDiscoveryPilotEnrollment"("ownerUserId", "cohortId", "createdAt");
