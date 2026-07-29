-- Different provider/failure groups may be owned by separate responder worktrees.
-- The existing partial unique index on (providerFamilyKey, failureFingerprint)
-- continues to prevent duplicate ownership of the same group.
DROP INDEX IF EXISTS "CourseSupportBatch_single_active_key";
