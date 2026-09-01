import type { SearchEmailDeliveryKind } from "@prisma/client";

export const DELIVERY_SYNTHETIC_MULTI_CYCLE_DRY_RUN =
  "DELIVERY_SYNTHETIC_MULTI_CYCLE_DRY_RUN";

export function areSearchStatusEmailsEnabled() {
  return true;
}

export function isSearchEmailDeliveryEnabled(kind: SearchEmailDeliveryKind) {
  return (
    kind === "MATCH" ||
    kind === "SETUP" ||
    kind === "MONITORING_STATUS_UPDATE" ||
    kind === "MONITORING_OUTAGE" ||
    kind === "MONITORING_RECOVERY"
  );
}
