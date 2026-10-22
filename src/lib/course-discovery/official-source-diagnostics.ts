/** Diagnostic facts never grant source, navigation, identity or recipe authority. */
export const officialSourceStages = ["CONTROLLER_CAPTURE", "SOURCE_CONTEXT", "OFFICIAL_SITE", "OFFICIAL_PROVENANCE", "RAW_DOCUMENT",
  "RAW_VENUE", "RAW_LINK", "RAW_ADDRESS", "RENDERED_VENUE", "RENDERED_LINK", "RENDERED_ADDRESS", "LOCATION_VERIFIED",
  "LOCATION_DERIVATION_REJECTED", "LEGACY_FALLBACK", "CHAIN_INCOMPLETE", "CHAIN_CURRENT", "INSPECTOR_REJECTED", "INSPECTOR_VERIFIED"] as const;
export const officialSourceBooleanKeys = ["rawOfficialCaptured", "currentOfficialDocument", "officialProvenance", "sourceContextValid", "officialSiteMatches",
  "rawVenueMatches", "rawAddressMatches", "rawLinkMatches", "renderedVenueMatches", "renderedAddressMatches", "renderedLinkMatches", "renderedFrameObserved",
  "renderedHeadingsPresent", "renderedAddressesPresent", "renderedLinksPresent", "chainHome", "chainBookingPage", "chainRedirect", "chainFinalDocument", "chainTokenCurrent", "legacyFallback", "derivationRejected"] as const;
export type OfficialSourceDiagnostic = { stage: typeof officialSourceStages[number] } & Partial<Record<typeof officialSourceBooleanKeys[number], boolean>>;
export function safeOfficialSourceDiagnostic(value: unknown): OfficialSourceDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (typeof record.stage !== "string" || !officialSourceStages.some(stage => stage === record.stage)) return;
  const result: OfficialSourceDiagnostic = { stage: record.stage as OfficialSourceDiagnostic["stage"] };
  for (const key of officialSourceBooleanKeys) if (typeof record[key] === "boolean") result[key] = record[key];
  return result;
}
export const navigationFailureKinds = ["TIMEOUT", "ABORTED", "DNS", "TLS", "NETWORK", "CLOSED", "UNKNOWN"] as const;
export type NavigationFailureKind = typeof navigationFailureKinds[number];
/** Raw browser messages are inspected only in process and are never retained. */
export function discoveryNavigationFailureKind(error: unknown): NavigationFailureKind {
  if (!(error instanceof Error)) return "UNKNOWN";
  if (error.name === "TimeoutError" || /(?:page\.goto|navigation).*timeout|timeout.*(?:page\.goto|navigation)/iu.test(error.message)) return "TIMEOUT";
  if (/ERR_ABORTED|navigation.*(?:cancelled|canceled|interrupted)/iu.test(error.message)) return "ABORTED";
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/iu.test(error.message)) return "DNS";
  if (/ERR_CERT_|ERR_SSL_|ERR_TLS_/iu.test(error.message)) return "TLS";
  if (/ERR_CONNECTION_|ERR_NETWORK_|ERR_INTERNET_DISCONNECTED|ERR_TIMED_OUT/iu.test(error.message)) return "NETWORK";
  if (/BROWSER_CLOSED|(?:page|browser|context).*closed/iu.test(error.message)) return "CLOSED";
  return "UNKNOWN";
}
