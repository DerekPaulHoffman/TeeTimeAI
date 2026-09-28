import { readAlertGenerationStartedAt } from "@/lib/searches/generation-clock";

export type OwnerEmailState =
  | "SENT"
  | "PENDING"
  | "NOT_SENT"
  | "FIRST_CHECK_PENDING";

export function getOwnerEmailState(input: {
  statuses: ReadonlySet<string> | undefined;
  status: string;
  alertGeneration: number;
  createdAt: Date;
  statusEmailSnapshot: unknown;
  lastCheckedAt: Date | null;
}): OwnerEmailState {
  if (input.statuses?.has("SENT")) return "SENT";
  if (["PENDING", "SENDING", "FAILED"].some((status) => input.statuses?.has(status))) {
    return "PENDING";
  }
  if (input.status !== "ACTIVE") return "NOT_SENT";

  const generationStartedAt = readAlertGenerationStartedAt(input);
  return generationStartedAt &&
    input.lastCheckedAt &&
    input.lastCheckedAt >= generationStartedAt
    ? "NOT_SENT"
    : "FIRST_CHECK_PENDING";
}
