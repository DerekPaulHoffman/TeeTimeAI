import type { SearchEmailDeliveryKind } from "@prisma/client";

export function areSearchStatusEmailsEnabled() {
  return false;
}

export function isSearchEmailDeliveryEnabled(kind: SearchEmailDeliveryKind) {
  return kind === "MATCH";
}
