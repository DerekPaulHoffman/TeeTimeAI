-- Distinct native-assigned courses may share a provider/failure group. Keep
-- legacy group uniqueness and add a stronger global active-course backstop.
-- Deploy the matching legacy-ownership guards before applying this migration.
-- Let the normal planner revoke older unclaimed launch authority first; verify
-- that no RESERVED/STARTING/BOUND authority remains on an older base.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtextextended('tee-time-spot:course-support-writer', 0));

CREATE UNIQUE INDEX "CourseSupportBatch_active_legacy_family_fingerprint_key"
ON "CourseSupportBatch" ("providerFamilyKey", "failureFingerprint")
WHERE "status" IN ('CLAIMED', 'IMPLEMENTING', 'VERIFYING')
  AND NOT (
    COALESCE("summary"->>'dispatchAssignmentRef', '') ~* '^course-assignment-[0-9a-f-]{36}$'
    AND COALESCE("summary"->>'dispatchCourseDigest', '') ~* '^[0-9a-f]{64}$'
  );

CREATE UNIQUE INDEX "CourseSupportBatch_active_assigned_course_key"
ON "CourseSupportBatch" ((lower("summary"->>'dispatchCourseDigest')))
WHERE "status" IN ('CLAIMED', 'IMPLEMENTING', 'VERIFYING')
  AND COALESCE("summary"->>'dispatchAssignmentRef', '') ~* '^course-assignment-[0-9a-f-]{36}$'
  AND COALESCE("summary"->>'dispatchCourseDigest', '') ~* '^[0-9a-f]{64}$';

DROP INDEX "CourseSupportBatch_active_family_fingerprint_key";
COMMIT;
