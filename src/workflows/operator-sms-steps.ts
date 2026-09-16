import { processOperatorSms } from "@/lib/operator-sms/service";

export async function deliverOperatorSmsStep(id: string) {
  "use step";
  return processOperatorSms(id);
}
