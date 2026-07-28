UPDATE "SearchEmailDelivery"
SET
  "status" = 'SUPPRESSED'::"SearchEmailDeliveryStatus",
  "claimToken" = NULL,
  "claimExpiresAt" = NULL,
  "nextAttemptAt" = NULL,
  "lastError" = 'Monitoring status emails disabled; review incidents in /operator.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "kind" IN (
  'MONITORING_OUTAGE'::"SearchEmailDeliveryKind",
  'MONITORING_RECOVERY'::"SearchEmailDeliveryKind"
)
AND "status" IN (
  'PENDING'::"SearchEmailDeliveryStatus",
  'FAILED'::"SearchEmailDeliveryStatus",
  'SENDING'::"SearchEmailDeliveryStatus"
);
