import { sleep } from "workflow";
import { deliverOperatorNotificationStep } from "./operator-notifications-steps";

export async function operatorNotificationWorkflow(id: string) {
  "use workflow";
  let next = await deliverOperatorNotificationStep(id);
  while (next) {
    await sleep(new Date(next.dueAt));
    next = await deliverOperatorNotificationStep(next.id);
  }
}
