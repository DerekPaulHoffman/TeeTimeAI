// Only a definite advisory-lock refusal is safe to repeat. Each new attempt
// runs the complete caller-supplied database transition with fresh guards.
import { COURSE_SUPPORT_WRITER_MIN_TRANSACTION_BUDGET_MS } from "./course-support-writer-budget";

type WriterResult<T> = { acquired: true; value: T } | { acquired: false };

const MAX_ATTEMPTS = 32;
const TOTAL_BUDGET_MS = 60_000;
const ADMISSION_WINDOW_MS = 15_000;
const BACKOFF_STEP_MS = 75;
const MAX_BACKOFF_MS = 750;

export async function retryCourseSupportWriterAdmission<T>(
  transition: (timeout: number) => Promise<WriterResult<T>>,
  options: { now?: () => number; sleep?: (milliseconds: number) => Promise<void> } = {},
): Promise<WriterResult<T>> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const deadline = startedAt + TOTAL_BUDGET_MS;
  const admissionDeadline = startedAt + ADMISSION_WINDOW_MS;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const currentTime = now();
    const remaining = Math.floor(deadline - currentTime);
    if ((attempt > 1 && currentTime >= admissionDeadline) ||
        remaining < COURSE_SUPPORT_WRITER_MIN_TRANSACTION_BUDGET_MS) return { acquired: false };
    // The lease timeout also covers Prisma's pool wait and the nested write.
    const result = await transition(remaining);
    if (!result || typeof result !== "object" || !("acquired" in result)) {
      throw new Error("Course-support writer returned an ambiguous result.");
    }
    if (result.acquired === true && "value" in result && Object.keys(result).length === 2) {
      return result as WriterResult<T>;
    }
    if (result.acquired !== false || Object.keys(result).length !== 1) {
      throw new Error("Course-support writer returned an ambiguous result.");
    }
    if (attempt === MAX_ATTEMPTS) return { acquired: false };
    const backoff = Math.min(BACKOFF_STEP_MS * attempt, MAX_BACKOFF_MS);
    if (Math.min(deadline - now() - COURSE_SUPPORT_WRITER_MIN_TRANSACTION_BUDGET_MS,
      admissionDeadline - now()) <= backoff) return { acquired: false };
    await sleep(backoff);
  }
  return { acquired: false };
}
