CREATE TYPE "OperatorSmsKind" AS ENUM ('CREATED', 'FOLLOWUP');
CREATE TYPE "OperatorSmsStatus" AS ENUM ('PENDING', 'SENDING', 'ACCEPTED', 'FAILED', 'UNCERTAIN', 'SUPPRESSED');
CREATE TABLE "OperatorSmsDelivery" (
    "id" TEXT NOT NULL,
    "sourceSearchId" TEXT NOT NULL,
    "teeSearchId" TEXT,
    "kind" "OperatorSmsKind" NOT NULL,
    "status" "OperatorSmsStatus" NOT NULL DEFAULT 'PENDING',
    "recipient" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "providerSid" TEXT,
    "providerStatus" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatorSmsDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OperatorSmsDelivery_providerSid_key" ON "OperatorSmsDelivery"("providerSid");
CREATE UNIQUE INDEX "OperatorSmsDelivery_sourceSearchId_kind_key" ON "OperatorSmsDelivery"("sourceSearchId", "kind");
CREATE INDEX "OperatorSmsDelivery_status_nextAttemptAt_idx" ON "OperatorSmsDelivery"("status", "nextAttemptAt");
CREATE INDEX "OperatorSmsDelivery_claimExpiresAt_idx" ON "OperatorSmsDelivery"("claimExpiresAt");
CREATE INDEX "OperatorSmsDelivery_createdAt_idx" ON "OperatorSmsDelivery"("createdAt");
ALTER TABLE "OperatorSmsDelivery" ADD CONSTRAINT "OperatorSmsDelivery_teeSearchId_fkey" FOREIGN KEY ("teeSearchId") REFERENCES "TeeSearch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
