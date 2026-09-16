import { processOperatorNotification } from "@/lib/operator-notifications/service";

export async function deliverOperatorNotificationStep(id: string) {
  "use step";
  return processOperatorNotification(id);
}
