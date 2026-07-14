export function hasClerkConfig() {
  return Boolean(getClerkConfig());
}

export function getClerkPublishableKey() {
  return getClerkConfig()?.publishableKey;
}

export function getClerkConfig() {
  const publishableKey = normalizeEnvValue(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const secretKey = normalizeEnvValue(process.env.CLERK_SECRET_KEY);

  if (!publishableKey || !secretKey || !isClerkKeyPair(publishableKey, secretKey)) {
    return undefined;
  }

  if (process.env.VERCEL_ENV === "production") {
    const productionReady =
      publishableKey.startsWith("pk_live_") &&
      secretKey.startsWith("sk_live_") &&
      normalizeEnvValue(process.env.CLERK_AUTH_READY) === "true";

    return productionReady ? { publishableKey, secretKey } : undefined;
  }

  return { publishableKey, secretKey };
}

export function hasDatabaseConfig() {
  return Boolean(normalizeEnvValue(process.env.DATABASE_URL));
}

export function hasGooglePlacesConfig() {
  return Boolean(normalizeEnvValue(process.env.GOOGLE_PLACES_API_KEY));
}

export function isVercelProduction() {
  return normalizeEnvValue(process.env.VERCEL_ENV) === "production";
}

export function hasAutomationApiKey() {
  return Boolean(process.env.AUTOMATION_API_KEY);
}

function isClerkKeyPair(publishableKey?: string, secretKey?: string) {
  const publishableEnvironment = getClerkKeyEnvironment(publishableKey, "pk");
  const secretEnvironment = getClerkKeyEnvironment(secretKey, "sk");

  return Boolean(
    publishableEnvironment &&
      publishableEnvironment === secretEnvironment &&
      isValidClerkPublishableKey(publishableKey)
  );
}

function getClerkKeyEnvironment(value: string | undefined, kind: "pk" | "sk") {
  return value?.match(new RegExp(`^${kind}_(test|live)_[A-Za-z0-9_-]+$`))?.[1];
}

function isValidClerkPublishableKey(value: string | undefined) {
  const encodedFrontendApi = value?.match(/^pk_(?:test|live)_([A-Za-z0-9_-]+)$/)?.[1];

  if (!encodedFrontendApi) {
    return false;
  }

  try {
    const decodedFrontendApi = Buffer.from(encodedFrontendApi, "base64url").toString("utf8");

    if (!decodedFrontendApi.endsWith("$")) {
      return false;
    }

    const frontendApi = decodedFrontendApi.slice(0, -1);
    return frontendApi.includes(".") && !frontendApi.includes("$");
  } catch {
    return false;
  }
}

function normalizeEnvValue(value?: string) {
  return value?.replace(/^\uFEFF/, "").trim();
}
