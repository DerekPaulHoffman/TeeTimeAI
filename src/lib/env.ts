export function hasClerkConfig() {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;

  if (!publishableKey || !secretKey || !isClerkKeyPair(publishableKey, secretKey)) {
    return false;
  }

  if (process.env.VERCEL_ENV === "production") {
    return publishableKey.startsWith("pk_live_") && secretKey.startsWith("sk_live_");
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
