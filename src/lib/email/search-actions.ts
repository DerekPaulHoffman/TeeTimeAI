import { createHmac, timingSafeEqual } from "node:crypto";

import { absoluteUrl } from "@/lib/seo";

export type EmailStopReason = "booked" | "cancelled";

export type EmailStopUrls = {
  booked: string;
  cancelled: string;
};

type EmailStopTokenPayload = {
  version: 1;
  searchId: string;
  reason: EmailStopReason;
  expiresAt: number;
};

const EMAIL_STOP_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export function buildEmailStopUrls(
  searchId: string,
  options: { now?: Date; expiresAt?: Date } = {}
): EmailStopUrls {
  return {
    booked: buildEmailStopUrl(searchId, "booked", options),
    cancelled: buildEmailStopUrl(searchId, "cancelled", options)
  };
}

export function createEmailStopToken(
  searchId: string,
  reason: EmailStopReason,
  options: { now?: Date; expiresAt?: Date; secret?: string } = {}
) {
  const now = options.now ?? new Date();
  const expiresAt = options.expiresAt ?? new Date(now.getTime() + EMAIL_STOP_TOKEN_LIFETIME_MS);
  if (expiresAt.getTime() <= now.getTime()) {
    throw new Error("Email alert control expiration must be in the future");
  }

  const payload: EmailStopTokenPayload = {
    version: 1,
    searchId,
    reason,
    expiresAt: expiresAt.getTime()
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(encodedPayload, options.secret ?? getEmailActionSecret());

  return `${encodedPayload}.${signature}`;
}

export function verifyEmailStopToken(
  token: string,
  options: { now?: Date; secret?: string } = {}
): EmailStopTokenPayload | null {
  const [encodedPayload, suppliedSignature, extraPart] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extraPart) {
    return null;
  }

  const suppliedBuffer = Buffer.from(suppliedSignature);
  const secrets = options.secret
    ? [options.secret]
    : getEmailActionVerificationSecrets();
  if (
    !secrets.some((secret) =>
      signatureMatches(encodedPayload, suppliedBuffer, secret)
    )
  ) {
    return null;
  }

  return parsePayload(encodedPayload, {
    now: options.now,
    allowExpired: false
  });
}

export function readEmailStopTokenForOwnerRecovery(
  token: string
): EmailStopTokenPayload | null {
  const [encodedPayload, suppliedSignature, extraPart] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extraPart) {
    return null;
  }

  return parsePayload(encodedPayload, { allowExpired: true });
}

function parsePayload(
  encodedPayload: string,
  options: { now?: Date; allowExpired: boolean }
) {
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as Partial<EmailStopTokenPayload>;
    const now = options.now ?? new Date();

    if (
      payload.version !== 1 ||
      typeof payload.searchId !== "string" ||
      payload.searchId.length === 0 ||
      payload.searchId.length > 200 ||
      (payload.reason !== "booked" && payload.reason !== "cancelled") ||
      typeof payload.expiresAt !== "number" ||
      (!options.allowExpired && payload.expiresAt <= now.getTime())
    ) {
      return null;
    }

    return payload as EmailStopTokenPayload;
  } catch {
    return null;
  }
}

function buildEmailStopUrl(
  searchId: string,
  reason: EmailStopReason,
  options: { now?: Date; expiresAt?: Date }
) {
  const token = createEmailStopToken(searchId, reason, options);
  return absoluteUrl(`/alerts/stop?token=${encodeURIComponent(token)}`);
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function signatureMatches(
  payload: string,
  suppliedBuffer: Buffer,
  secret: string
) {
  const expectedBuffer = Buffer.from(sign(payload, secret));
  return (
    suppliedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(suppliedBuffer, expectedBuffer)
  );
}

function getEmailActionSecret() {
  const secret = normalizeSecret(process.env.EMAIL_ACTION_SECRET);
  if (!secret) {
    throw new Error("EMAIL_ACTION_SECRET is required for email alert controls");
  }
  return secret;
}

function getEmailActionVerificationSecrets() {
  const current = getEmailActionSecret();
  const previous = normalizeSecret(process.env.EMAIL_ACTION_SECRET_PREVIOUS);
  return previous && previous !== current ? [current, previous] : [current];
}

function normalizeSecret(value?: string) {
  return value?.replace(/\uFEFF/g, "").trim();
}
