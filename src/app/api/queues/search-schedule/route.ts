import { handleCallback } from "@vercel/queue";

import {
  getSearchScheduleQueueRetryDirective
} from "@/lib/automation/search-recheck-queue";
import { consumeSearchScheduleQueueMessage } from "@/lib/automation/search-schedule-consumer";

export const runtime = "nodejs";

export const POST = handleCallback(
  async (message) => {
    await consumeSearchScheduleQueueMessage(message);
  },
  {
    visibilityTimeoutSeconds: 120,
    retry: (error, metadata) =>
      getSearchScheduleQueueRetryDirective(error, metadata.deliveryCount)
  }
);
