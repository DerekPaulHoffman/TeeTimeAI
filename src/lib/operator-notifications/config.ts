import { createECDH, createHash } from "node:crypto";

const value = (name: string) =>
  process.env[name]?.replace(/^\uFEFF/, "").trim() ?? "";

function getBaseConfig() {
  // Production opt-in only: previews and local tests must never notify a phone.
  if (
    value("OPERATOR_NOTIFICATIONS_ENABLED") !== "true" ||
    value("VERCEL_ENV") !== "production"
  )
    return null;
  const ownerEmail = value("OPERATOR_NOTIFICATIONS_OWNER_EMAIL").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) return null;
  try {
    const url = new URL(value("NEXT_PUBLIC_SITE_URL"));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      return null;
    return {
      ownerEmail,
      origin: url.origin,
      excludedEmails: [
        ...new Set([
          ownerEmail,
          ...value("OPERATOR_NOTIFICATIONS_EXCLUDED_EMAILS")
            .split(",")
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean),
        ]),
      ],
    };
  } catch {
    return null;
  }
}

function getNtfyTopic() {
  const topic = value("OPERATOR_NTFY_TOPIC");
  return /^[a-f0-9]{48}$/.test(topic) ? topic : null;
}

export function getOperatorNotificationConfig() {
  const base = getBaseConfig();
  if (!base || getNtfyTopic()) return null;
  const publicKey = value("OPERATOR_PUSH_VAPID_PUBLIC_KEY");
  const privateKey = value("OPERATOR_PUSH_VAPID_PRIVATE_KEY");
  if (
    !/^[A-Za-z0-9_-]{87}$/.test(publicKey) ||
    !/^[A-Za-z0-9_-]{43}$/.test(privateKey)
  )
    return null;
  try {
    const key = createECDH("prime256v1");
    key.setPrivateKey(Buffer.from(privateKey, "base64url"));
    if (key.getPublicKey().toString("base64url") !== publicKey) return null;
    return { ...base, publicKey, privateKey };
  } catch {
    return null;
  }
}

export function getOperatorNotificationDeliveryConfig() {
  const topic = getNtfyTopic();
  if (!topic) return getOperatorNotificationConfig();
  const base = getBaseConfig();
  if (!base) return null;
  return {
    ...base,
    topic,
    recipient: `ntfy:${createHash("sha256").update(topic).digest("hex")}`,
  };
}

export type OperatorNotificationConfig = NonNullable<
  ReturnType<typeof getOperatorNotificationConfig>
>;
