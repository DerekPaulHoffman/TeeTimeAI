const value = (name: string) =>
  process.env[name]?.replace(/^\uFEFF/, "").trim() ?? "";

export function getOperatorSmsConfig() {
  // Preview and local environments must never text the operator.
  if (
    value("OPERATOR_SMS_ENABLED") !== "true" ||
    value("VERCEL_ENV") !== "production"
  )
    return null;
  const accountSid = value("TWILIO_ACCOUNT_SID");
  const authToken = value("TWILIO_AUTH_TOKEN");
  const from = value("TWILIO_SMS_FROM");
  const to = value("OPERATOR_SMS_TO");
  const excludedEmails = value("OPERATOR_SMS_EXCLUDED_EMAILS")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  const siteUrl = value("NEXT_PUBLIC_SITE_URL");
  if (
    !/^AC[0-9a-f]{32}$/i.test(accountSid) ||
    !authToken ||
    !/^\+[1-9]\d{7,14}$/.test(from) ||
    !/^\+[1-9]\d{7,14}$/.test(to) ||
    !excludedEmails.length
  )
    return null;
  try {
    const url = new URL(siteUrl);
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
      accountSid,
      authToken,
      from,
      to,
      excludedEmails,
      origin: url.origin,
    };
  } catch {
    return null;
  }
}

export type OperatorSmsConfig = NonNullable<
  ReturnType<typeof getOperatorSmsConfig>
>;
