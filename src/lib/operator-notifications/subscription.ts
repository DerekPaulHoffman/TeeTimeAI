import { ECDH } from "node:crypto";

export type OperatorPushDetails = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

// This feature targets Chrome on Android. Never permit a client-provided push
// endpoint to turn the authenticated sender into an arbitrary URL fetcher.
export function parseOperatorPushSubscription(
  input: unknown,
): OperatorPushDetails | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  const { endpoint, keys } = candidate;
  if (
    typeof endpoint !== "string" ||
    endpoint.length > 2048 ||
    typeof keys?.p256dh !== "string" ||
    typeof keys.auth !== "string"
  )
    return null;
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "fcm.googleapis.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      !/^\/(?:fcm\/send|wp)\/[A-Za-z0-9_:-]+$/.test(url.pathname)
    )
      return null;
    if (
      !/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh) ||
      !/^[A-Za-z0-9_-]{22}$/.test(keys.auth)
    )
      return null;
    const point = Buffer.from(keys.p256dh, "base64url");
    if (
      point.length !== 65 ||
      point[0] !== 4 ||
      point.toString("base64url") !== keys.p256dh ||
      Buffer.from(keys.auth, "base64url").toString("base64url") !== keys.auth
    )
      return null;
    ECDH.convertKey(point, "prime256v1");
    return { endpoint: url.href, p256dh: keys.p256dh, auth: keys.auth };
  } catch {
    return null;
  }
}
