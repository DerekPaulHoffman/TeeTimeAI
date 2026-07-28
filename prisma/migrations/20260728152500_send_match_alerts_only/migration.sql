UPDATE "SearchEmailDelivery"
SET
  "status" = 'SUPPRESSED'::"SearchEmailDeliveryStatus",
  "claimToken" = NULL,
  "claimExpiresAt" = NULL,
  "nextAttemptAt" = NULL,
  "lastError" = 'Non-match email disabled; Tee Time Spot sends availability alerts only.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" <> 'MATCH'::"SearchEmailDeliveryKind"
AND "status" IN (
  'PENDING'::"SearchEmailDeliveryStatus",
  'FAILED'::"SearchEmailDeliveryStatus",
  'SENDING'::"SearchEmailDeliveryStatus"
);
