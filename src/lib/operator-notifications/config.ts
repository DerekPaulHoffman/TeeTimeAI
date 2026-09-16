import { createECDH } from "node:crypto";

const value = (name: string) =>
  process.env[name]?.replace(/^\uFEFF/, "").trim() ?? "";

export function getOperatorNotificationConfig() {
  // Production opt-in only: previews and local tests must never notify a phone.
  if (
    value("OPERATOR_NOTIFICATIONS_ENABLED") !== "true" ||
    value("VERCEL_ENV") !== "production"
  )
    return null;
  const publicKey = value("OPERATOR_PUSH_VAPID_PUBLIC_KEY");
  const privateKey = value("OPERATOR_PUSH_VAPID_PRIVATE_KEY");
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
    if (
      !/^[A-Za-z0-9_-]{87}$/.test(publicKey) ||
      !/^[A-Za-z0-9_-]{43}$/.test(privateKey)
    )
      return null;
    const key = createECDH("prime256v1");
    key.setPrivateKey(Buffer.from(privateKey, "base64url"));
    if (key.getPublicKey().toString("base64url") !== publicKey) return null;
    return {
      publicKey,
      privateKey,
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

export type OperatorNotificationConfig = NonNullable<
  ReturnType<typeof getOperatorNotificationConfig>
>;
