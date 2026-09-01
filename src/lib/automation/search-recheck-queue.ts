import { createHash, randomUUID } from "node:crypto";

import { send } from "@vercel/queue";
import { z } from "zod";

import {
  queueSearchCheck
} from "@/lib/automation/db-service";
import {
  getCourseLocalDateStorageBoundary
} from "@/lib/automation/date-boundary";
import { prisma } from "@/lib/prisma";

export const SEARCH_SCHEDULE_QUEUE_TOPIC = "tee-time-spot-search-schedule";
export const SEARCH_SCHEDULE_QUEUE_RETENTION_SECONDS = 24 * 60 * 60;

export const searchScheduleQueueMessageSchema = z
  .object({
    searchId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value === value.trim(), "Search ID must not contain outer whitespace"),
    scheduleVersion: z.number().int().nonnegative(),
    trigger: z.enum(["START_FAILED", "COURSE_REMEDIATED"])
  })
  .strict();

export type SearchScheduleQueueMessage = z.infer<typeof searchScheduleQueueMessageSchema>;
export type SearchScheduleQueueRequest = SearchScheduleQueueMessage;

type SearchScheduleQueueState = {
  workflowRunId?: string | null;
  checkStatus?: string;
};

export type SearchScheduleWorkflowStartDependencies = {
  startWorkflow: (
    searchId: string,
    scheduleVersion: number
  ) => Promise<{ runId: string }>;
  attachWorkflowRun: (
    searchId: string,
    scheduleVersion: number,
    runId: string,
    expectedWorkflowRunId: string | null
  ) => Promise<{ count: number }>;
};

export type SearchScheduleQueueDependencies =
  SearchScheduleWorkflowStartDependencies & {
    getScheduleState: (
      searchId: string,
      scheduleVersion: number
    ) => Promise<SearchScheduleQueueState | null>;
  };

const SEARCH_SCHEDULE_START_RESERVATION_PREFIX =
  "tee-search-schedule-starting:";

type SearchScheduleQueueProducerDependencies = {
  sendMessage: (
    topic: string,
    message: SearchScheduleQueueMessage,
    options: { idempotencyKey: string; retentionSeconds: number }
  ) => Promise<unknown>;
};

type RemediatedCourseRecheckDependencies = {
  listSearchIds: (courseIds: string[]) => Promise<string[]>;
  queueSearch: (
    searchId: string,
    remediationDispatchKey?: string
  ) => Promise<{ scheduleVersion: number }>;
  enqueue: (
    message: SearchScheduleQueueRequest,
    idempotencySeed?: string
  ) => Promise<void>;
};

type RemediatedCoursePreference = {
  teeSearchId: string;
  teeSearch: { date: Date };
  course: { timeZone: string };
};

export function selectCurrentRemediatedSearchIds(
  preferences: readonly RemediatedCoursePreference[],
  now = new Date()
) {
  const searchIds = new Set<string>();
  for (const preference of preferences) {
    if (
      preference.teeSearch.date.getTime() >=
      getCourseLocalDateStorageBoundary(
        preference.course.timeZone,
        now
      ).getTime()
    ) {
      searchIds.add(preference.teeSearchId);
    }
  }
  return [...searchIds];
}

const defaultProducerDependencies: SearchScheduleQueueProducerDependencies = {
  sendMessage: async (topic, message, options) => {
    await send(topic, message, options);
  }
};

const defaultRemediatedCourseRecheckDependencies: RemediatedCourseRecheckDependencies = {
  listSearchIds: async (courseIds) => {
    const preferences = await prisma.coursePreference.findMany({
      where: {
        courseId: { in: courseIds },
        teeSearch: {
          status: "ACTIVE"
        }
      },
      select: {
        teeSearchId: true,
        teeSearch: { select: { date: true } },
        course: { select: { timeZone: true } }
      }
    });
    return selectCurrentRemediatedSearchIds(preferences);
  },
  queueSearch: async (searchId, remediationDispatchKey) => {
    const queued = await queueSearchCheck(searchId, remediationDispatchKey);
    if (!queued || queued.status !== "ACTIVE") {
      throw new Error("Search is no longer active.");
    }
    return queued;
  },
  // Local responder runs persist QUEUED state. Deployed schedule recovery
  // picks it up on its next heartbeat without a local Queue or Workflow call.
  enqueue: async () => undefined
};

export class InvalidSearchScheduleQueueMessageError extends Error {
  constructor() {
    super("Invalid search schedule queue message");
    this.name = "InvalidSearchScheduleQueueMessageError";
  }
}

export async function enqueueSearchScheduleMessage(
  input: SearchScheduleQueueRequest,
  dependencies: SearchScheduleQueueProducerDependencies = defaultProducerDependencies,
  idempotencySeed: string = randomUUID()
) {
  const message = parseSearchScheduleQueueMessage(input);
  await dependencies.sendMessage(SEARCH_SCHEDULE_QUEUE_TOPIC, message, {
    idempotencyKey: buildSearchScheduleQueueIdempotencyKey(message, idempotencySeed),
    retentionSeconds: SEARCH_SCHEDULE_QUEUE_RETENTION_SECONDS
  });
}

export async function recoverSearchScheduleStartFailure(
  input: SearchScheduleQueueRequest,
  dependencies: {
    enqueue: (message: SearchScheduleQueueRequest) => Promise<void>;
  } = {
    enqueue: enqueueSearchScheduleMessage
  }
) {
  const message = parseSearchScheduleQueueMessage(input);
  try {
    await dependencies.enqueue(message);
    return { outcome: "queued" as const };
  } catch {
    return { outcome: "failed" as const };
  }
}

export async function enqueueRemediatedCourseRechecks(
  courseIds: string[],
  dependencies: RemediatedCourseRecheckDependencies =
    defaultRemediatedCourseRecheckDependencies,
  remediationDispatchKey?: string,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const uniqueCourseIds = [...new Set(courseIds.filter(Boolean))];
  if (uniqueCourseIds.length === 0) {
    return {
      affectedSearchCount: 0,
      queuedCount: 0,
      queueFailureCount: 0,
      directStartCount: 0,
      scheduledSearches: [] as Array<{
        searchId: string;
        searchRef: string;
        scheduleVersion: number;
      }>,
      affectedSearchRefs: [] as Array<{
        searchRef: string;
        scheduleVersion: number | null;
      }>
    };
  }

  const searchIds = [...new Set(await dependencies.listSearchIds(uniqueCourseIds))];
  signal?.throwIfAborted();
  let queuedCount = 0;
  let queueFailureCount = 0;
  const directStartCount = 0;
  const scheduledSearches: Array<{
    searchId: string;
    searchRef: string;
    scheduleVersion: number;
  }> = [];
  const affectedSearchRefs: Array<{
    searchRef: string;
    scheduleVersion: number | null;
  }> = [];
  for (const searchId of searchIds) {
    signal?.throwIfAborted();
    const searchRef = buildSearchScheduleReference(searchId);
    let queued: { scheduleVersion: number };
    try {
      queued = await dependencies.queueSearch(searchId, remediationDispatchKey);
    } catch {
      signal?.throwIfAborted();
      queueFailureCount += 1;
      affectedSearchRefs.push({ searchRef, scheduleVersion: null });
      continue;
    }
    affectedSearchRefs.push({
      searchRef,
      scheduleVersion: queued.scheduleVersion
    });
    scheduledSearches.push({
      searchId,
      searchRef,
      scheduleVersion: queued.scheduleVersion
    });
    try {
      signal?.throwIfAborted();
      const request = {
        searchId,
        scheduleVersion: queued.scheduleVersion,
        trigger: "COURSE_REMEDIATED"
      } as const;
      if (remediationDispatchKey) {
        await dependencies.enqueue(request, remediationDispatchKey);
      } else {
        await dependencies.enqueue(request);
      }
      signal?.throwIfAborted();
      queuedCount += 1;
    } catch {
      signal?.throwIfAborted();
      queueFailureCount += 1;
      // The persisted QUEUED row remains eligible for deployed schedule recovery.
    }
  }

  signal?.throwIfAborted();
  return {
    affectedSearchCount: searchIds.length,
    queuedCount,
    queueFailureCount,
    directStartCount,
    scheduledSearches,
    affectedSearchRefs
  };
}

export async function consumeSearchScheduleMessage(
  input: unknown,
  dependencies: SearchScheduleQueueDependencies
) {
  const message = parseSearchScheduleQueueMessage(input);
  const state = await dependencies.getScheduleState(
    message.searchId,
    message.scheduleVersion
  );
  if (!state) {
    return { outcome: "stale" as const };
  }
  if (isSearchScheduleWorkflowStartReservation(state.workflowRunId)) {
    // A prior consumer durably won the right to call Workflow but may not have
    // attached the returned run yet. Treat the reservation as an active start;
    // the existing attached-QUEUED recovery path generation-fences a crashed
    // starter instead of allowing an at-least-once delivery to start in parallel.
    return { outcome: "start_reserved" as const };
  }
  if (state.workflowRunId && state.checkStatus !== "FAILED") {
    return { outcome: "already_started" as const };
  }

  const result = await startSearchScheduleWorkflowWithReservation(
    {
      searchId: message.searchId,
      scheduleVersion: message.scheduleVersion,
      expectedWorkflowRunId: state.workflowRunId ?? null,
    },
    dependencies,
  );
  return result.outcome === "started"
    ? { outcome: "started" as const }
    : { outcome: result.outcome };
}

export async function startSearchScheduleWorkflowWithReservation(
  input: {
    searchId: string;
    scheduleVersion: number;
    expectedWorkflowRunId: string | null;
  },
  dependencies: SearchScheduleWorkflowStartDependencies,
) {
  if (isSearchScheduleWorkflowStartReservation(input.expectedWorkflowRunId)) {
    return { outcome: "start_reserved" as const };
  }
  const startReservation = buildSearchScheduleWorkflowStartReservation();
  const reserved = await dependencies.attachWorkflowRun(
    input.searchId,
    input.scheduleVersion,
    startReservation,
    input.expectedWorkflowRunId,
  );
  if (reserved.count !== 1) {
    return { outcome: "stale_before_start" as const };
  }

  // A thrown Workflow start is ambiguous: the remote service may have accepted
  // the run before the caller lost the response. Keep the durable reservation
  // so an at-least-once redelivery cannot start the same generation again. The
  // existing attached-QUEUED recovery path later generation-fences this work.
  const run = await dependencies.startWorkflow(
    input.searchId,
    input.scheduleVersion,
  );
  const attached = await dependencies.attachWorkflowRun(
    input.searchId,
    input.scheduleVersion,
    run.runId,
    startReservation,
  );
  if (attached.count !== 1) {
    return { outcome: "stale_after_start" as const, runId: run.runId };
  }

  return { outcome: "started" as const, runId: run.runId };
}

export function isSearchScheduleWorkflowStartReservation(
  workflowRunId: string | null | undefined
) {
  return Boolean(
    workflowRunId?.startsWith(SEARCH_SCHEDULE_START_RESERVATION_PREFIX)
  );
}

function buildSearchScheduleWorkflowStartReservation() {
  return `${SEARCH_SCHEDULE_START_RESERVATION_PREFIX}${randomUUID()}`;
}

export function getSearchScheduleQueueRetryDirective(error: unknown, deliveryCount: number) {
  if (error instanceof InvalidSearchScheduleQueueMessageError) {
    return { acknowledge: true as const };
  }

  return {
    afterSeconds: Math.min(5 * 60, Math.max(15, 2 ** Math.min(deliveryCount, 6) * 5))
  };
}

export function buildSearchScheduleQueueIdempotencyKey(
  message: Pick<SearchScheduleQueueMessage, "searchId" | "scheduleVersion">,
  eventNonce: string = randomUUID()
) {
  const digest = createHash("sha256")
    .update(`${message.searchId}:${message.scheduleVersion}:${eventNonce}`)
    .digest("hex")
    .slice(0, 32);
  return `tee-search-schedule-${digest}`;
}

export function buildSearchScheduleReference(searchId: string) {
  return createHash("sha256").update(searchId).digest("hex");
}

function parseSearchScheduleQueueMessage(input: unknown) {
  const parsed = searchScheduleQueueMessageSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidSearchScheduleQueueMessageError();
  }
  return parsed.data;
}
