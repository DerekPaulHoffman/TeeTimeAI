import { start } from "workflow/api";
import { operatorNotificationWorkflow } from "@/workflows/operator-notifications";
import { prisma } from "@/lib/prisma";
import { getOperatorNotificationConfig } from "./config";
import { listOperatorNotificationForRecovery } from "./service";

async function launch(id: string) {
  await start(operatorNotificationWorkflow, [id], { deploymentId: "latest" });
}

export async function startOperatorNotificationForSearch(
  sourceSearchId: string,
) {
  if (!getOperatorNotificationConfig()) return;
  try {
    const delivery = await prisma.operatorNotificationDelivery.findFirst({
      where: { sourceSearchId, status: "PENDING" },
      orderBy: { nextAttemptAt: "asc" },
      select: { id: true, status: true },
    });
    if (delivery?.status === "PENDING") await launch(delivery.id);
  } catch {
    console.error(
      "[operator-notifications:start-failed] Recovery will retry the persisted delivery.",
    );
  }
}

export async function recoverOperatorNotification() {
  const deliveries = await listOperatorNotificationForRecovery();
  let failed = 0;
  for (const delivery of deliveries) {
    try {
      await launch(delivery.id);
    } catch {
      failed++;
    }
  }
  if (failed)
    console.error("[operator-notifications:recovery-start-failed]", { failed });
  return { considered: deliveries.length, failed };
}
