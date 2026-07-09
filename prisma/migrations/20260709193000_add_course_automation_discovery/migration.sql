-- CreateTable
CREATE TABLE "CourseAutomationDiscovery" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detectedPlatform" "DetectedPlatform" NOT NULL DEFAULT 'UNKNOWN',
    "sourceUrl" TEXT NOT NULL,
    "bookingUrl" TEXT,
    "apiEndpoint" TEXT,
    "apiMetadata" JSONB,
    "evidence" JSONB,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CourseAutomationDiscovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CourseAutomationDiscovery_courseId_createdAt_idx" ON "CourseAutomationDiscovery"("courseId", "createdAt");

-- CreateIndex
CREATE INDEX "CourseAutomationDiscovery_status_createdAt_idx" ON "CourseAutomationDiscovery"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CourseAutomationDiscovery_detectedPlatform_createdAt_idx" ON "CourseAutomationDiscovery"("detectedPlatform", "createdAt");

-- AddForeignKey
ALTER TABLE "CourseAutomationDiscovery" ADD CONSTRAINT "CourseAutomationDiscovery_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
