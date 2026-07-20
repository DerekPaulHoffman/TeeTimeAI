-- Preserve an authoritative Clerk email change until any in-flight delivery finishes.
ALTER TABLE "User"
ADD COLUMN "clerkUserUpdatedAt" TIMESTAMP(3),
ADD COLUMN "pendingEmail" TEXT,
ADD COLUMN "pendingEmailObservedAt" TIMESTAMP(3);

CREATE INDEX "User_pendingEmailObservedAt_idx"
ON "User"("pendingEmailObservedAt");

-- Fail closed if a rolling-deploy predecessor tries to change the email without
-- advancing the authoritative Clerk source version, including on legacy null rows.
-- The only same-version change allowed is promotion of the exact staged email.
CREATE FUNCTION "guard_clerk_user_email_version"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."email" IS DISTINCT FROM OLD."email"
    AND NOT (
      NEW."clerkUserUpdatedAt" IS NOT NULL
      AND (
        OLD."clerkUserUpdatedAt" IS NULL
        OR NEW."clerkUserUpdatedAt" > OLD."clerkUserUpdatedAt"
      )
    )
    AND NOT (
      OLD."pendingEmail" IS NOT NULL
      AND NEW."email" = OLD."pendingEmail"
      AND NEW."pendingEmail" IS NULL
      AND NEW."clerkUserUpdatedAt" IS NOT DISTINCT FROM OLD."clerkUserUpdatedAt"
    )
  THEN
    RAISE EXCEPTION 'Unversioned Clerk email transition rejected'
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "User_guard_clerk_email_version"
BEFORE UPDATE OF "email" ON "User"
FOR EACH ROW
EXECUTE FUNCTION "guard_clerk_user_email_version"();
