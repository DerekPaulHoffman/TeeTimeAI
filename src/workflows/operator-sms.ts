import { sleep } from "workflow";
import { deliverOperatorSmsStep } from "./operator-sms-steps";

export async function operatorSmsWorkflow(id: string) {
  "use workflow";
  let next = await deliverOperatorSmsStep(id);
  while (next) {
    await sleep(new Date(next.dueAt));
    next = await deliverOperatorSmsStep(next.id);
  }
}
