export function hasClerkConfig() {
  const publishableKey = normalizeEnvValue(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const secretKey = normalizeEnvValue(process.env.CLERK_SECRET_KEY);

  if (!publishableKey || !secretKey || !isClerkKeyPair(publishableKey, secretKey)) {
    return false;
  }

  if (process.env.VERCEL_ENV === "production") {
    return (
      publishableKey.startsWith("pk_live_") &&
      secretKey.startsWith("sk_live_") &&
      normalizeEnvValue(process.env.CLERK_AUTH_READY) === "true"
    );
  }

  return true;
}

export function hasDatabaseConfig() {
  return Boolean(process.env.DATABASE_URL);
}

export function hasAutomationApiKey() {
  return Boolean(process.env.AUTOMATION_API_KEY);
}

function isClerkKeyPair(publishableKey?: string, secretKey?: string) {
  return Boolean(
    publishableKey?.match(/^pk_(test|live)_/) && secretKey?.match(/^sk_(test|live)_/)
  );
}

function normalizeEnvValue(value?: string) {
  return value?.replace(/^\uFEFF/, "").trim();
}
