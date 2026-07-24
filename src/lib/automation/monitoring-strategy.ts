import {
  resolveProviderCapability,
  SOURCE_CONFLICT_PROVIDER_FAMILY,
  SOURCE_MISSING_PROVIDER_FAMILY,
  type CourseSupportFailureClass,
  type ProviderCourseInput
} from "./provider-capabilities";
import {
  evaluateMonitoringGate,
  type MonitoringGateInput
} from "./policy";

export const MONITORING_STRATEGY_ACTIONS = [
  "RUN_TYPED_ADAPTER",
  "DISCOVER_WITH_HTTP",
  "DISCOVER_WITH_BROWSER",
  "VERIFY_TECHNICAL_CONSTRAINT",
  "RETRY_PROVIDER",
  "REPAIR_PROVIDER_ADAPTER",
  "FINAL_TECHNICAL_CONSTRAINT",
  "FINAL_MANUAL_BOOKING",
  "FINAL_PRIVATE_OR_INVALID"
] as const;

export type MonitoringStrategyAction =
  (typeof MONITORING_STRATEGY_ACTIONS)[number];

export type MonitoringDiscoveryAttempt = "NONE" | "HTTP_INCONCLUSIVE";

export type MonitoringStrategyInput = ProviderCourseInput &
  MonitoringGateInput & {
    failureClass?: CourseSupportFailureClass | null;
    discoveryAttempt?: MonitoringDiscoveryAttempt;
  };

export type MonitoringStrategyDecision = {
  action: MonitoringStrategyAction;
  reason:
    | "RUNNABLE_PROVIDER"
    | "MISSING_PROVIDER_SOURCE"
    | "MISSING_PROVIDER_METADATA"
    | "CONFLICTING_PROVIDER_EVIDENCE"
    | "UNKNOWN_PROVIDER_FAMILY"
    | "KNOWN_UNSUPPORTED_PROVIDER"
    | "TRANSIENT_PROVIDER_FAILURE"
    | "PROVIDER_ADAPTER_DEFECT"
    | "TECHNICAL_ACCESS_REQUIRES_VERIFICATION"
    | "CURRENT_TECHNICAL_CONSTRAINT"
    | "CURRENT_MANUAL_BOOKING"
    | "PRIVATE_OR_INVALID"
    | "PRIVATE_IDENTITY_RECHECK"
    | "STORED_BLOCK_REQUIRES_REVALIDATION"
    | "UNSAFE_DISCOVERY_SOURCE";
  providerFamilyKey: string;
  browserAllowed: boolean;
};

const TRANSIENT_PROVIDER_FAILURES = new Set<CourseSupportFailureClass>([
  "RATE_LIMIT",
  "HTTP_5XX",
  "TIMEOUT",
  "NETWORK"
]);
const ADAPTER_DEFECT_FAILURES = new Set<CourseSupportFailureClass>([
  "NOT_FOUND",
  "SCHEMA",
  "UNKNOWN"
]);
const DISCOVERY_FAILURES = new Set<CourseSupportFailureClass>([
  "MISSING_SOURCE",
  "MISSING_METADATA"
]);
const TECHNICAL_ACCESS_FAILURES = new Set<CourseSupportFailureClass>([
  "AUTH",
  "CHALLENGE"
]);

export function selectMonitoringStrategy(
  input: MonitoringStrategyInput
): MonitoringStrategyDecision {
  const gate = evaluateMonitoringGate(input);
  const provider = resolveProviderCapability(input);
  const providerFamilyKey = provider.providerFamilyKey;

  if (gate.disposition === "IDENTITY_FINAL") {
    return decision(
      "FINAL_PRIVATE_OR_INVALID",
      "PRIVATE_OR_INVALID",
      providerFamilyKey
    );
  }
  if (gate.disposition === "IDENTITY_RECHECK") {
    const safeDiscoverySource = hasSafePublicDiscoverySource(input);
    if (!safeDiscoverySource) {
      return decision(
        "REPAIR_PROVIDER_ADAPTER",
        "UNSAFE_DISCOVERY_SOURCE",
        providerFamilyKey
      );
    }
    if ((input.discoveryAttempt ?? "NONE") === "HTTP_INCONCLUSIVE") {
      return decision(
        "DISCOVER_WITH_BROWSER",
        "PRIVATE_IDENTITY_RECHECK",
        providerFamilyKey,
        true
      );
    }
    return decision(
      "DISCOVER_WITH_HTTP",
      "PRIVATE_IDENTITY_RECHECK",
      providerFamilyKey
    );
  }
  if (gate.disposition === "MANUAL_FINAL") {
    return decision(
      "FINAL_MANUAL_BOOKING",
      "CURRENT_MANUAL_BOOKING",
      providerFamilyKey
    );
  }
  if (gate.disposition === "TECHNICAL_FINAL") {
    return decision(
      "FINAL_TECHNICAL_CONSTRAINT",
      "CURRENT_TECHNICAL_CONSTRAINT",
      providerFamilyKey
    );
  }

  if (
    input.failureClass &&
    TECHNICAL_ACCESS_FAILURES.has(input.failureClass)
  ) {
    return decision(
      "VERIFY_TECHNICAL_CONSTRAINT",
      "TECHNICAL_ACCESS_REQUIRES_VERIFICATION",
      providerFamilyKey,
      hasSafePublicDiscoverySource(input)
    );
  }
  if (input.automationEligibility === "BLOCKED") {
    return decision(
      "DISCOVER_WITH_HTTP",
      "STORED_BLOCK_REQUIRES_REVALIDATION",
      providerFamilyKey
    );
  }

  if (provider.isRunnable) {
    if (
      input.failureClass &&
      TRANSIENT_PROVIDER_FAILURES.has(input.failureClass)
    ) {
      return decision(
        "RETRY_PROVIDER",
        "TRANSIENT_PROVIDER_FAILURE",
        providerFamilyKey
      );
    }
    if (
      input.failureClass &&
      ADAPTER_DEFECT_FAILURES.has(input.failureClass)
    ) {
      return decision(
        "REPAIR_PROVIDER_ADAPTER",
        "PROVIDER_ADAPTER_DEFECT",
        providerFamilyKey
      );
    }
    return decision(
      "RUN_TYPED_ADAPTER",
      "RUNNABLE_PROVIDER",
      providerFamilyKey
    );
  }

  if (provider.capability && !provider.capability.supportsAutomation) {
    return decision(
      "REPAIR_PROVIDER_ADAPTER",
      "KNOWN_UNSUPPORTED_PROVIDER",
      providerFamilyKey
    );
  }

  const discoveryReason =
    providerFamilyKey === SOURCE_MISSING_PROVIDER_FAMILY
      ? "MISSING_PROVIDER_SOURCE"
      : providerFamilyKey === SOURCE_CONFLICT_PROVIDER_FAMILY
        ? "CONFLICTING_PROVIDER_EVIDENCE"
        : provider.capability || input.failureClass === "MISSING_METADATA"
          ? "MISSING_PROVIDER_METADATA"
          : "UNKNOWN_PROVIDER_FAMILY";
  const needsDiscovery =
    !input.failureClass ||
    DISCOVERY_FAILURES.has(input.failureClass) ||
    input.failureClass === "UNSUPPORTED_FAMILY";

  if (!needsDiscovery) {
    return decision(
      "REPAIR_PROVIDER_ADAPTER",
      "PROVIDER_ADAPTER_DEFECT",
      providerFamilyKey
    );
  }

  const safeDiscoverySource = hasSafePublicDiscoverySource(input);
  if (!safeDiscoverySource) {
    return decision(
      "REPAIR_PROVIDER_ADAPTER",
      "UNSAFE_DISCOVERY_SOURCE",
      providerFamilyKey
    );
  }

  if ((input.discoveryAttempt ?? "NONE") === "HTTP_INCONCLUSIVE") {
    return decision(
      "DISCOVER_WITH_BROWSER",
      discoveryReason,
      providerFamilyKey,
      true
    );
  }
  return decision(
    "DISCOVER_WITH_HTTP",
    discoveryReason,
    providerFamilyKey
  );
}

export function hasSafePublicDiscoverySource(
  input: Pick<ProviderCourseInput, "detectedBookingUrl" | "website">
) {
  return [input.detectedBookingUrl, input.website].some((value) => {
    if (!value) {
      return false;
    }
    try {
      const url = new URL(value);
      const hostname = url.hostname
        .toLocaleLowerCase("en-US")
        .replace(/\.$/u, "")
        .replace(/^\[|\]$/gu, "");
      return Boolean(
        ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          hostname &&
          hostname !== "localhost" &&
          !hostname.endsWith(".localhost") &&
          !hostname.endsWith(".local") &&
          !isPrivateIpLiteral(hostname)
      );
    } catch {
      return false;
    }
  });
}

export function shouldStopBrowserDiscovery(input: {
  accessBarrierCount: number;
  accessControlDetected: boolean;
}) {
  return input.accessBarrierCount > 0 || input.accessControlDetected;
}

function decision(
  action: MonitoringStrategyAction,
  reason: MonitoringStrategyDecision["reason"],
  providerFamilyKey: string,
  browserAllowed = false
): MonitoringStrategyDecision {
  return {
    action,
    reason,
    providerFamilyKey,
    browserAllowed:
      browserAllowed &&
      ["DISCOVER_WITH_BROWSER", "VERIFY_TECHNICAL_CONSTRAINT"].includes(action)
  };
}

function isPrivateIpLiteral(hostname: string) {
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number);
    if (octets.some((value) => value > 255)) {
      return true;
    }
    return Boolean(
      octets[0] === 0 ||
        octets[0] === 10 ||
        octets[0] === 127 ||
        (octets[0] === 169 && octets[1] === 254) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168) ||
        octets[0] >= 224
    );
  }
  return (
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:")
  );
}
