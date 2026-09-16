import twilio from "twilio";
import type { OperatorSmsConfig } from "./config";

export class SmsSendError extends Error {
  constructor(
    public readonly outcome: "retry" | "failed" | "uncertain",
    public readonly code: string,
  ) {
    super(`Operator SMS ${outcome}: ${code}`);
  }
}

export function operatorSmsCallbackUrl(
  config: OperatorSmsConfig,
  id: string,
  token: string,
) {
  const url = new URL("/api/webhooks/twilio/operator-sms", config.origin);
  url.searchParams.set("id", id);
  url.searchParams.set("attempt", token);
  return url.toString();
}

export async function sendOperatorSms(
  config: OperatorSmsConfig,
  input: { id: string; token: string; body: string; to: string },
) {
  try {
    const message = await twilio(config.accountSid, config.authToken, {
      autoRetry: false,
      timeout: 15_000,
    }).messages.create({
      from: config.from,
      to: input.to,
      body: input.body,
      statusCallback: operatorSmsCallbackUrl(config, input.id, input.token),
    });
    return { sid: message.sid, status: message.status };
  } catch (error) {
    const status = (error as { status?: number }).status;
    const code = (error as { code?: number }).code;
    // Only a definite rejection is safe to resend. A timeout/5xx may have
    // accepted the SMS; the signed callback can reconcile that attempt.
    throw new SmsSendError(
      status === 429
        ? "retry"
        : status && status >= 400 && status < 500
          ? "failed"
          : "uncertain",
      typeof code === "number" && Number.isSafeInteger(code)
        ? String(code)
        : typeof status === "number"
          ? String(status)
          : "transport",
    );
  }
}

export function validateOperatorSmsCallback(
  config: OperatorSmsConfig,
  url: string,
  signature: string,
  params: Record<string, string>,
) {
  return (
    twilio.validateRequest(config.authToken, signature, url, params) &&
    params.AccountSid === config.accountSid
  );
}
