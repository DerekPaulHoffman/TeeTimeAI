import { handleCallback } from "@vercel/queue";

import {
  getSearchScheduleQueueRetryDirective
} from "@/lib/automation/search-recheck-queue";
import { consumeSearchScheduleQueueMessage } from "@/lib/automation/search-schedule-consumer";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const queueCallback = handleCallback(
    async (message) => {
      await consumeSearchScheduleQueueMessage(message);
    },
    {
      visibilityTimeoutSeconds: 120,
      retry: (error, metadata) =>
        getSearchScheduleQueueRetryDirective(error, metadata.deliveryCount)
    }
  );
  return queueCallback(request);
}
