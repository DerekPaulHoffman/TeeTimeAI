import { createHash, randomUUID } from "node:crypto";

import { send } from "@vercel/queue";
import { z } from "zod";
import { start } from "workflow/api";

import {
  attachSearchWorkflowRun,
  getSearchScheduleState,
  queueSearchCheck
} from "@/lib/automation/db-service";
import { startOfUtcCalendarDay } from "@/lib/automation/date-boundary";
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

type SearchScheduleQueueDependencies = {
  getScheduleState: (
    searchId: string,
    scheduleVersion: number
  ) => Promise<SearchScheduleQueueState | null>;
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
  recover: (message: SearchScheduleQueueMessage) => Promise<{
    outcome: "stale" | "already_started" | "stale_after_start" | "started";
  }>;
};

const defaultConsumerDependencies: SearchScheduleQueueDependencies = {
  getScheduleState: async (searchId, scheduleVersion) =>
    getSearchScheduleState(searchId, scheduleVersion),
  startWorkflow: async (searchId, scheduleVersion) => {
    const { searchScheduleWorkflow } = await import("@/workflows/search-schedule");
    const run = await start(searchScheduleWorkflow, [searchId, scheduleVersion], {
      deploymentId: "latest"
    });
    return { runId: run.runId };
  },
  attachWorkflowRun: async (
    searchId,
    scheduleVersion,
    runId,
    expectedWorkflowRunId
  ) =>
    attachSearchWorkflowRun(
      searchId,
      scheduleVersion,
      runId,
      expectedWorkflowRunId
    )
};

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
          status: "ACTIVE",
          date: { gte: startOfUtcCalendarDay() }
        }
      },
      distinct: ["teeSearchId"],
      select: { teeSearchId: true }
    });
    return preferences.map((preference) => preference.teeSearchId);
  },
  queueSearch: async (searchId, remediationDispatchKey) => {
    const queued = await queueSearchCheck(searchId, remediationDispatchKey);
    if (!queued || queued.status !== "ACTIVE") {
      throw new Error("Search is no longer active.");
    }
    return queued;
  },
  enqueue: async (message, idempotencySeed) =>
    enqueueSearchScheduleMessage(message, defaultProducerDependencies, idempotencySeed),
  recover: async (message) => consumeSearchScheduleMessage(message)
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
    recover: (message: SearchScheduleQueueMessage) => Promise<{
      outcome: "stale" | "already_started" | "stale_after_start" | "started";
    }>;
  } = {
    enqueue: enqueueSearchScheduleMessage,
    recover: consumeSearchScheduleMessage
  }
) {
  const message = parseSearchScheduleQueueMessage(input);
  try {
    await dependencies.enqueue(message);
    return { outcome: "queued" as const };
  } catch {
    try {
      const recovered = await dependencies.recover(message);
      return {
        outcome:
          recovered.outcome === "started" ||
          recovered.outcome === "already_started"
            ? ("started_directly" as const)
            : ("stale" as const)
      };
    } catch {
      return { outcome: "failed" as const };
    }
  }
}

export async function enqueueRemediatedCourseRechecks(
  courseIds: string[],
  dependencies: RemediatedCourseRecheckDependencies =
    defaultRemediatedCourseRecheckDependencies,
  remediationDispatchKey?: string
) {
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
  let queuedCount = 0;
  let queueFailureCount = 0;
  let directStartCount = 0;
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
    const searchRef = buildSearchScheduleReference(searchId);
    let queued: { scheduleVersion: number };
    try {
      queued = await dependencies.queueSearch(searchId, remediationDispatchKey);
    } catch {
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
      queuedCount += 1;
    } catch {
      queueFailureCount += 1;
      try {
        const recovered = await dependencies.recover({
          searchId,
          scheduleVersion: queued.scheduleVersion,
          trigger: "COURSE_REMEDIATED"
        });
        if (
          recovered.outcome === "started" ||
          recovered.outcome === "already_started"
        ) {
          queuedCount += 1;
          directStartCount += 1;
        }
      } catch {
        // The persisted QUEUED row remains eligible for schedule recovery.
      }
    }
  }

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
  dependencies: SearchScheduleQueueDependencies = defaultConsumerDependencies
) {
  const message = parseSearchScheduleQueueMessage(input);
  const state = await dependencies.getScheduleState(
    message.searchId,
    message.scheduleVersion
  );
  if (!state) {
    return { outcome: "stale" as const };
  }
  if (state.workflowRunId && state.checkStatus !== "FAILED") {
    return { outcome: "already_started" as const };
  }

  const run = await dependencies.startWorkflow(message.searchId, message.scheduleVersion);
  const attached = await dependencies.attachWorkflowRun(
    message.searchId,
    message.scheduleVersion,
    run.runId,
    state.workflowRunId ?? null
  );
  if (attached.count !== 1) {
    return { outcome: "stale_after_start" as const };
  }

  return { outcome: "started" as const };
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
