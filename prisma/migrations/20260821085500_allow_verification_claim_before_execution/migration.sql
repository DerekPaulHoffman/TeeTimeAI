ALTER TABLE "CourseSupportVerificationRequest"
DROP CONSTRAINT "CourseSupportVerification_execution_state_check";

ALTER TABLE "CourseSupportVerificationRequest"
ADD CONSTRAINT "CourseSupportVerification_execution_state_check"
CHECK (
  ("status" <> 'CHECKING' OR (
    "runtimeVersion" = "releaseSha"
    AND "leaseToken" IS NOT NULL
    AND "leaseExpiresAt" IS NOT NULL
  ))
  AND (
    "status" NOT IN ('QUEUED', 'RETRYABLE_FAILED')
    OR "nextAttemptAt" IS NOT NULL
  )
  AND (
    "status" <> 'RETRYABLE_FAILED'
    OR "nextAttemptAt" < "createdAt" + INTERVAL '24 hours'
  )
  AND (
    "status" = 'CHECKING'
    OR ("leaseToken" IS NULL AND "leaseExpiresAt" IS NULL)
  )
  AND "revision" >= 0
  AND "attemptCount" >= 0
);
