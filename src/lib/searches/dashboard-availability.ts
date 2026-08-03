export type DashboardAvailabilitySnapshot = {
  visibleSlotCount: number;
  playerEligibleSlotCount: number;
  closestBefore?: string;
  closestAfter?: string;
};

export type DashboardAvailabilityView = {
  label: string;
  detail: string;
  tone: "matching" | "available" | "empty" | "scheduled" | "unavailable" | "pending";
};

const NEW_COURSE_INCIDENT_WINDOW_MS = 2 * 60 * 1000;

export function isDashboardMonitoringSetupInProgress(input: {
  courseCreatedAt: Date;
  latestOutcome?: string | null;
  incident?: {
    status: string;
    firstSeenAt: Date;
  } | null;
}) {
  return (
    input.latestOutcome === "NEEDS_ADAPTER" &&
    input.incident?.status === "AUTO_INVESTIGATING" &&
    Math.abs(input.incident.firstSeenAt.getTime() - input.courseCreatedAt.getTime()) <=
      NEW_COURSE_INCIDENT_WINDOW_MS
  );
}

export function readDashboardAvailabilitySnapshot(
  rawSummary: unknown
): DashboardAvailabilitySnapshot | null {
  if (!rawSummary || typeof rawSummary !== "object" || Array.isArray(rawSummary)) {
    return null;
  }

  const summary = rawSummary as Record<string, unknown>;
  const visibleSlotCount = readNonNegativeInteger(summary.visibleSlotCount);
  const playerEligibleSlotCount = readNonNegativeInteger(
    summary.playerEligibleSlotCount
  );
  if (visibleSlotCount === null || playerEligibleSlotCount === null) {
    return null;
  }

  return {
    visibleSlotCount,
    playerEligibleSlotCount,
    ...(readLocalDateTime(summary.closestBefore)
      ? { closestBefore: summary.closestBefore as string }
      : {}),
    ...(readLocalDateTime(summary.closestAfter)
      ? { closestAfter: summary.closestAfter as string }
      : {})
  };
}

export function getDashboardAvailabilityView(input: {
  outcome?: string | null;
  rawSummary?: unknown;
  qualifyingMatchCount: number;
  players: number;
  startTime: string;
  endTime: string;
  bookingOpensLabel?: string | null;
  monitoringSetupInProgress?: boolean;
}): DashboardAvailabilityView {
  const snapshot = readDashboardAvailabilitySnapshot(input.rawSummary);
  const golferLabel = `${input.players} ${
    input.players === 1 ? "golfer" : "golfers"
  }`;

  if (input.qualifyingMatchCount > 0) {
    return {
      label: `${input.qualifyingMatchCount} matching ${
        input.qualifyingMatchCount === 1 ? "time" : "times"
      }`,
      detail: `${input.qualifyingMatchCount} ${
        input.qualifyingMatchCount === 1 ? "tee time fits" : "tee times fit"
      } your ${formatTime(input.startTime)} to ${formatTime(input.endTime)} window for ${golferLabel}.`,
      tone: "matching"
    };
  }

  if (input.bookingOpensLabel) {
    return {
      label: "Booking not open yet",
      detail: `Tee times are expected to appear ${input.bookingOpensLabel}. We'll start checking at the useful release time.`,
      tone: "scheduled"
    };
  }

  if (input.monitoringSetupInProgress) {
    return {
      label: "Monitoring setup in progress",
      detail:
        "We haven't connected to this course's public tee sheet yet. Use the official course site for current availability while Tee Time Spot works on alert coverage.",
      tone: "scheduled"
    };
  }

  if (input.outcome === "NO_MATCH") {
    if (snapshot && snapshot.visibleSlotCount > 0) {
      if (snapshot.playerEligibleSlotCount > 0) {
        return {
          label: "Available outside your window",
          detail: `${snapshot.playerEligibleSlotCount} ${pluralize(
            snapshot.playerEligibleSlotCount,
            "tee time is",
            "tee times are"
          )} available for ${golferLabel}, but none fall between ${formatTime(
            input.startTime
          )} and ${formatTime(input.endTime)}.${formatNearestAvailability(snapshot)}`,
          tone: "available"
        };
      }

      return {
        label: "Availability found",
        detail: `${snapshot.visibleSlotCount} public ${pluralize(
          snapshot.visibleSlotCount,
          "tee time is",
          "tee times are"
        )} listed, but none currently fit ${golferLabel}.`,
        tone: "available"
      };
    }

    if (snapshot?.visibleSlotCount === 0) {
      return {
        label: "No public times listed",
        detail: "The latest public tee-sheet check returned no times for this date.",
        tone: "empty"
      };
    }

    return {
      label: "No qualifying times yet",
      detail: `The latest check found no tee times that fit your ${formatTime(
        input.startTime
      )} to ${formatTime(input.endTime)} request for ${golferLabel}.`,
      tone: "empty"
    };
  }

  if (input.outcome === "MATCH_FOUND") {
    return {
      label: "Availability found recently",
      detail:
        "The latest check found a matching time, but it is not currently listed as available. We'll keep checking.",
      tone: "available"
    };
  }

  if (
    input.outcome === "FETCH_FAILED" ||
    input.outcome === "BLOCKED_TOOLING" ||
    input.outcome === "NEEDS_ADAPTER" ||
    input.outcome === "BLOCKED_AUTH" ||
    input.outcome === "BLOCKED_POLICY"
  ) {
    return {
      label: "Current availability unavailable",
      detail:
        "We could not confirm the current tee sheet. Use the official course site while Tee Time Spot keeps working on coverage.",
      tone: "unavailable"
    };
  }

  return {
    label: "Waiting for the first check",
    detail: "We'll show current availability here as soon as the first course check finishes.",
    tone: "pending"
  };
}

function formatNearestAvailability(snapshot: DashboardAvailabilitySnapshot) {
  if (snapshot.closestBefore && snapshot.closestAfter) {
    return ` Nearest: ${formatTime(snapshot.closestBefore)} before your window and ${formatTime(
      snapshot.closestAfter
    )} after it.`;
  }
  if (snapshot.closestBefore) {
    return ` The nearest earlier time is ${formatTime(snapshot.closestBefore)}.`;
  }
  if (snapshot.closestAfter) {
    return ` The nearest later time is ${formatTime(snapshot.closestAfter)}.`;
  }
  return "";
}

function formatTime(value: string) {
  const match = value.match(/(?:T|\s|^)(\d{2}):(\d{2})/);
  if (!match) return value;
  const hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

function pluralize(count: number, singular: string, plural: string) {
  return count === 1 ? singular : plural;
}

function readNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function readLocalDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}(?:T|\s)\d{2}:\d{2}/.test(value)
  );
}
