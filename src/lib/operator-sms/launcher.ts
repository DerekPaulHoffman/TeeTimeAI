import { start } from "workflow/api";
import { operatorSmsWorkflow } from "@/workflows/operator-sms";
import { prisma } from "@/lib/prisma";
import { getOperatorSmsConfig } from "./config";
import { listOperatorSmsForRecovery } from "./service";

async function launch(id: string) {
  await start(operatorSmsWorkflow, [id], { deploymentId: "latest" });
}

export async function startOperatorSmsForSearch(sourceSearchId: string) {
  if (!getOperatorSmsConfig()) return;
  try {
    const delivery = await prisma.operatorSmsDelivery.findFirst({
      where: { sourceSearchId, status: "PENDING" },
      orderBy: { nextAttemptAt: "asc" },
      select: { id: true, status: true },
    });
    if (delivery?.status === "PENDING") await launch(delivery.id);
  } catch {
    console.error(
      "[operator-sms:start-failed] Recovery will retry the persisted delivery.",
    );
  }
}

export async function recoverOperatorSms() {
  const deliveries = await listOperatorSmsForRecovery();
  let failed = 0;
  for (const delivery of deliveries) {
    try {
      await launch(delivery.id);
    } catch {
      failed++;
    }
  }
  if (failed) console.error("[operator-sms:recovery-start-failed]", { failed });
  return { considered: deliveries.length, failed };
}
