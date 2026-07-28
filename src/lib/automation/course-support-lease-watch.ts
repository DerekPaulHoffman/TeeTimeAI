export const DEFAULT_COURSE_SUPPORT_HEARTBEAT_INTERVAL_MS = 4 * 60 * 1_000;
export const DEFAULT_COURSE_SUPPORT_LEASE_WATCH_MINUTES = 45;

export async function runCourseSupportLeaseWatch(input: {
  maxMinutes?: number;
  intervalMs?: number;
  renew: () => Promise<{ heartbeatRecorded: boolean; leaseExpiresAt?: string | null }>;
  onRenewed?: (input: {
    renewalCount: number;
    leaseExpiresAt?: string | null;
  }) => void;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const maxMinutes =
    input.maxMinutes ?? DEFAULT_COURSE_SUPPORT_LEASE_WATCH_MINUTES;
  const intervalMs =
    input.intervalMs ?? DEFAULT_COURSE_SUPPORT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isInteger(maxMinutes) || maxMinutes < 5 || maxMinutes > 60) {
    throw new Error("--max-minutes must be an integer from 5 through 60.");
  }
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < 60_000 ||
    intervalMs > 5 * 60_000
  ) {
    throw new Error(
      "--interval-seconds must be an integer from 60 through 300."
    );
  }

  const now = input.now ?? Date.now;
  const sleep =
    input.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + maxMinutes * 60_000;
  let renewalCount = 0;

  while (now() < deadline) {
    const result = await input.renew();
    if (!result.heartbeatRecorded) {
      throw new Error("Course-support lease watch lost durable batch ownership.");
    }
    renewalCount += 1;
    input.onRenewed?.({
      renewalCount,
      leaseExpiresAt: result.leaseExpiresAt
    });
    const remainingMs = deadline - now();
    if (remainingMs <= intervalMs) {
      break;
    }
    await sleep(intervalMs);
  }

  return {
    outcome: "lease_watch_complete" as const,
    heartbeatRecorded: true,
    renewalCount,
    maxMinutes
  };
}
