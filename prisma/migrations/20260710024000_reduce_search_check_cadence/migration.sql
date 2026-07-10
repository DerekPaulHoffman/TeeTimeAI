ALTER TABLE "TeeSearch"
ALTER COLUMN "cadenceMinutes" SET DEFAULT 5;

UPDATE "TeeSearch"
SET "cadenceMinutes" = 5
WHERE "status" = 'ACTIVE'
  AND "cadenceMinutes" > 5;
