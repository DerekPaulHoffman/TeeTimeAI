ALTER TABLE "LocalReaderJob"
ADD COLUMN "resumeFromScheduleVersion" INTEGER,
ADD COLUMN "resumeScheduleVersion" INTEGER;

ALTER TABLE "LocalReaderJob"
ADD CONSTRAINT "LocalReaderJob_resume_generation_check"
CHECK (
  (
    "resumeFromScheduleVersion" IS NULL
    AND "resumeScheduleVersion" IS NULL
  )
  OR
  (
    "teeSearchId" IS NOT NULL
    AND "status" = 'COMPLETED'
    AND "completedAt" IS NOT NULL
    AND "scheduleVersion" IS NOT NULL
    AND "scheduleVersion" >= 0
    AND "resumeFromScheduleVersion" IS NOT NULL
    AND "resumeFromScheduleVersion" >= "scheduleVersion"
    AND "resumeScheduleVersion" IS NOT NULL
    AND "resumeScheduleVersion" = "resumeFromScheduleVersion" + 1
  )
);
