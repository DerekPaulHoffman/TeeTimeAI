import { handleCallback } from "@vercel/queue";

import {
  consumeSearchScheduleMessage,
  getSearchScheduleQueueRetryDirective
} from "@/lib/automation/search-recheck-queue";

export const runtime = "nodejs";

export const POST = handleCallback(
  async (message) => {
    await consumeSearchScheduleMessage(message);
  },
  {
    visibilityTimeoutSeconds: 120,
    retry: (error, metadata) =>
      getSearchScheduleQueueRetryDirective(error, metadata.deliveryCount)
  }
);
