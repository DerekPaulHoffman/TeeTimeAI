-- CreateEnum
CREATE TYPE "FeedbackSentiment" AS ENUM ('LIKE', 'DISLIKE', 'BROKEN');

-- CreateTable
CREATE TABLE "WebsiteEvent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "page" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteFeedback" (
    "id" TEXT NOT NULL,
    "sentiment" "FeedbackSentiment" NOT NULL,
    "message" TEXT,
    "page" TEXT,
    "contactEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "WebsiteFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebsiteEvent_name_createdAt_idx" ON "WebsiteEvent"("name", "createdAt");

-- CreateIndex
CREATE INDEX "WebsiteEvent_createdAt_idx" ON "WebsiteEvent"("createdAt");

-- CreateIndex
CREATE INDEX "WebsiteFeedback_sentiment_createdAt_idx" ON "WebsiteFeedback"("sentiment", "createdAt");

-- CreateIndex
CREATE INDEX "WebsiteFeedback_createdAt_idx" ON "WebsiteFeedback"("createdAt");
