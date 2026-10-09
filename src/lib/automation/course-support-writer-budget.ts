import type { PostgresAdvisoryLeaseContext } from "./lease";

const INNER_TIMEOUT_MS = 15_000;
const INNER_POOL_WAIT_MS = 2_000;
const COMMIT_HEADROOM_MS = 5_000;
export const COURSE_SUPPORT_WRITER_MIN_TRANSACTION_BUDGET_MS =
  INNER_POOL_WAIT_MS + INNER_TIMEOUT_MS + COMMIT_HEADROOM_MS;

function remaining(context: PostgresAdvisoryLeaseContext) {
  return context.deadlineAt.getTime() - Date.now();
}

export function courseSupportWriterTransactionOptions(context: PostgresAdvisoryLeaseContext) {
  // Reserve time for Prisma's independent inner pool wait, transaction, and
  // commit before the outer advisory-lock transaction can expire.
  if (remaining(context) < COURSE_SUPPORT_WRITER_MIN_TRANSACTION_BUDGET_MS) {
    throw new Error("Course-support writer budget expired before the transition could start.");
  }
  return { maxWait: INNER_POOL_WAIT_MS, timeout: INNER_TIMEOUT_MS };
}

export function assertCourseSupportWriterTransactionStart(context: PostgresAdvisoryLeaseContext) {
  if (remaining(context) < INNER_TIMEOUT_MS + COMMIT_HEADROOM_MS) {
    throw new Error("Course-support writer budget expired while waiting for the transition connection.");
  }
}

export function assertCourseSupportWriterCommitHeadroom(context: PostgresAdvisoryLeaseContext) {
  if (remaining(context) < COMMIT_HEADROOM_MS) {
    throw new Error("Course-support writer budget expired before transition commit.");
  }
}
