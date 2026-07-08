import type { TeeTimeSlot } from "@/lib/tee-times/matching";

export type ProbeInput = {
  searchId: string;
  courseId: string;
  outcome:
    | "MATCH_FOUND"
    | "NO_MATCH"
    | "BLOCKED_POLICY"
    | "BLOCKED_AUTH"
    | "BLOCKED_TOOLING"
    | "FETCH_FAILED"
    | "NEEDS_ADAPTER";
  observedAt?: Date;
  message?: string;
  evidenceUrl?: string;
  rawSummary?: unknown;
  automationRunId?: string;
};

export type MatchInput = TeeTimeSlot & {
  searchId: string;
};

type MatchRecord = MatchInput & {
  alertStatus: "PENDING" | "SENT" | "SUPPRESSED";
  sentCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
};

export type AutomationStore = {
  probes: unknown[];
  matches: MatchRecord[];
};

export function createAutomationService(store: AutomationStore) {
  return {
    async recordProbe(input: ProbeInput) {
      store.probes.push({
        ...input,
        observedAt: input.observedAt ?? new Date()
      });
    },

    async recordMatch(input: MatchInput) {
      const existing = store.matches.find((match) => isSameMatch(match, input));

      if (existing) {
        existing.lastSeenAt = new Date();
        return existing;
      }

      const record: MatchRecord = {
        ...input,
        alertStatus: "PENDING",
        sentCount: 0,
        firstSeenAt: new Date(),
        lastSeenAt: new Date()
      };
      store.matches.push(record);
      return record;
    },

    async markAlertSent(searchId: string, courseId: string, sourceId: string) {
      const match = store.matches.find(
        (record) =>
          record.searchId === searchId &&
          record.courseId === courseId &&
          record.sourceId === sourceId
      );

      if (!match || match.alertStatus === "SENT") {
        return match ?? null;
      }

      match.alertStatus = "SENT";
      match.sentCount += 1;
      return match;
    }
  };
}

function isSameMatch(existing: MatchRecord, input: MatchInput) {
  return (
    existing.searchId === input.searchId &&
    existing.courseId === input.courseId &&
    existing.sourceId === input.sourceId &&
    existing.startsAt === input.startsAt
  );
}
