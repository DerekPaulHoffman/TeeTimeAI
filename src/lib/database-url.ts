const LOCAL_DATABASE_URL =
  "postgresql://teetimespot:teetimespot@localhost:5432/teetimespot?schema=public";
const PRISMA_GENERATE_DATABASE_URL =
  "postgresql://generate:generate@prisma-generate.invalid:5432/generate";

interface DatabaseEnvironment {
  [key: string]: string | undefined;
  DATABASE_URL?: string;
  DATABASE_URL_UNPOOLED?: string;
  VERCEL?: string;
  VERCEL_ENV?: string;
}

interface PrismaCliDatabaseUrlOptions {
  allowVercelGeneratePlaceholder?: boolean;
}

export function resolveRuntimeDatabaseUrl(
  environment: DatabaseEnvironment = process.env
) {
  const databaseUrl = normalizeEnvValue(environment.DATABASE_URL);
  if (databaseUrl) {
    return databaseUrl;
  }

  if (isVercelRuntime(environment)) {
    throw new Error("DATABASE_URL is required when Tee Time Spot runs on Vercel.");
  }

  return LOCAL_DATABASE_URL;
}

export function resolvePrismaCliDatabaseUrl(
  environment: DatabaseEnvironment = process.env,
  options: PrismaCliDatabaseUrlOptions = {}
) {
  const databaseUrl =
    normalizeEnvValue(environment.DATABASE_URL_UNPOOLED) ??
    normalizeEnvValue(environment.DATABASE_URL);

  if (databaseUrl) {
    return databaseUrl;
  }

  if (isVercelRuntime(environment)) {
    if (options.allowVercelGeneratePlaceholder) {
      return PRISMA_GENERATE_DATABASE_URL;
    }

    throw new Error(
      "DATABASE_URL_UNPOOLED or DATABASE_URL is required for Prisma on Vercel."
    );
  }

  return LOCAL_DATABASE_URL;
}

function isVercelRuntime(environment: DatabaseEnvironment) {
  return (
    normalizeEnvValue(environment.VERCEL) === "1" ||
    normalizeEnvValue(environment.VERCEL_ENV) !== undefined
  );
}

function normalizeEnvValue(value?: string) {
  const normalized = value?.replace(/^\uFEFF/, "").trim();
  return normalized || undefined;
}
