CREATE TABLE "OperatorPushSubscription" (
    "id" TEXT NOT NULL,
    "ownerEmail" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "lastTestAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatorPushSubscription_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OperatorPushSubscription_ownerEmail_key" ON "OperatorPushSubscription"("ownerEmail");
CREATE UNIQUE INDEX "OperatorPushSubscription_endpoint_key" ON "OperatorPushSubscription"("endpoint");

CREATE TYPE "OperatorNotificationKind" AS ENUM ('CREATED', 'FOLLOWUP');
CREATE TYPE "OperatorNotificationStatus" AS ENUM ('PENDING', 'SENDING', 'ACCEPTED', 'FAILED', 'UNCERTAIN', 'SUPPRESSED');
CREATE TABLE "OperatorNotificationDelivery" (
    "id" TEXT NOT NULL,
    "sourceSearchId" TEXT NOT NULL,
    "teeSearchId" TEXT,
    "kind" "OperatorNotificationKind" NOT NULL,
    "status" "OperatorNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "recipient" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "claimExpiresAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "providerStatus" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OperatorNotificationDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OperatorNotificationDelivery_providerMessageId_key" ON "OperatorNotificationDelivery"("providerMessageId");
CREATE UNIQUE INDEX "OperatorNotificationDelivery_sourceSearchId_kind_key" ON "OperatorNotificationDelivery"("sourceSearchId", "kind");
CREATE INDEX "OperatorNotificationDelivery_status_nextAttemptAt_idx" ON "OperatorNotificationDelivery"("status", "nextAttemptAt");
CREATE INDEX "OperatorNotificationDelivery_claimExpiresAt_idx" ON "OperatorNotificationDelivery"("claimExpiresAt");
CREATE INDEX "OperatorNotificationDelivery_createdAt_idx" ON "OperatorNotificationDelivery"("createdAt");
ALTER TABLE "OperatorNotificationDelivery" ADD CONSTRAINT "OperatorNotificationDelivery_teeSearchId_fkey" FOREIGN KEY ("teeSearchId") REFERENCES "TeeSearch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
