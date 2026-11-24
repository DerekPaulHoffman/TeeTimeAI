import { OperatorNotificationSendError } from "./push";

export const NTFY_NEW_ALERT_MESSAGE = "New Tee Time Spot alert";

export async function sendOperatorNtfyNotification(
  config: { topic: string; origin: string },
  test = false,
) {
  if (!/^[a-f0-9]{48}$/.test(config.topic))
    throw new OperatorNotificationSendError("failed", "invalid_ntfy_topic");

  try {
    const response = await fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: config.topic,
        message: test ? "Tee Time Spot phone notification test" : NTFY_NEW_ALERT_MESSAGE,
        click: new URL("/operator", config.origin).href,
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
      throw new OperatorNotificationSendError(
        "retry",
        "ntfy_429",
        Number.isSafeInteger(seconds) ? Math.min(seconds, 86400) : undefined,
      );
    }
    if (response.status >= 400 && response.status < 500)
      throw new OperatorNotificationSendError("failed", `ntfy_${response.status}`);
    if (!response.ok)
      throw new OperatorNotificationSendError("uncertain", "ntfy_transport");

    const receipt = await response.json();
    if (
      receipt?.event !== "message" ||
      typeof receipt.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(receipt.id)
    )
      throw new OperatorNotificationSendError("uncertain", "ntfy_receipt_missing");
    return { messageId: `ntfy:${receipt.id}`, status: "accepted" };
  } catch (error) {
    if (error instanceof OperatorNotificationSendError) throw error;
    throw new OperatorNotificationSendError("uncertain", "ntfy_transport");
  }
}
