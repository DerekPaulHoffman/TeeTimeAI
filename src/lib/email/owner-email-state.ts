import { readAlertGenerationStartedAt } from "@/lib/searches/generation-clock";

export type OwnerEmailState =
  | "SENT"
  | "PREVIOUSLY_SENT"
  | "PENDING"
  | "NOT_SENT"
  | "FIRST_CHECK_PENDING";

export function getOwnerEmailState(input: {
  statuses: ReadonlySet<string> | undefined;
  previouslySent: boolean;
  status: string;
  alertGeneration: number;
  createdAt: Date;
  statusEmailSnapshot: unknown;
  lastCheckedAt: Date | null;
}): OwnerEmailState {
  if (input.statuses?.has("SENT")) return "SENT";
  if (input.status !== "ACTIVE") {
    return input.previouslySent ? "PREVIOUSLY_SENT" : "NOT_SENT";
  }
  if (["PENDING", "SENDING", "FAILED"].some((status) => input.statuses?.has(status))) {
    return "PENDING";
  }

  const generationStartedAt = readAlertGenerationStartedAt(input);
  return generationStartedAt &&
    input.lastCheckedAt &&
    input.lastCheckedAt >= generationStartedAt
    ? "NOT_SENT"
    : "FIRST_CHECK_PENDING";
}
