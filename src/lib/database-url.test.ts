import { describe, expect, it } from "vitest";

import {
  resolvePrismaCliDatabaseUrl,
  resolveRuntimeDatabaseUrl
} from "./database-url";

const localDatabaseUrl =
  "postgresql://teetimespot:teetimespot@localhost:5432/teetimespot?schema=public";

describe("database URL resolution", () => {
  it("uses the pooled database URL for application traffic", () => {
    expect(
      resolveRuntimeDatabaseUrl({
        DATABASE_URL: "\uFEFF postgresql://pooled.example/teetimespot ",
        DATABASE_URL_UNPOOLED: "postgresql://direct.example/teetimespot"
      })
    ).toBe("postgresql://pooled.example/teetimespot");
  });

  it("prefers the direct database URL for Prisma CLI operations", () => {
    expect(
      resolvePrismaCliDatabaseUrl({
        DATABASE_URL: "postgresql://pooled.example/teetimespot",
        DATABASE_URL_UNPOOLED: " postgresql://direct.example/teetimespot "
      })
    ).toBe("postgresql://direct.example/teetimespot");
  });

  it("falls back to the pooled URL for Prisma when no direct URL is configured", () => {
    expect(
      resolvePrismaCliDatabaseUrl({
        DATABASE_URL: "postgresql://pooled.example/teetimespot"
      })
    ).toBe("postgresql://pooled.example/teetimespot");
  });

  it("permits the conventional localhost database only outside Vercel", () => {
    expect(resolveRuntimeDatabaseUrl({})).toBe(localDatabaseUrl);
    expect(resolvePrismaCliDatabaseUrl({})).toBe(localDatabaseUrl);
  });

  it("fails clearly instead of falling back to localhost on Vercel", () => {
    expect(() => resolveRuntimeDatabaseUrl({ VERCEL: "1" })).toThrow(
      "DATABASE_URL is required when Tee Time Spot runs on Vercel."
    );
    expect(() => resolvePrismaCliDatabaseUrl({ VERCEL_ENV: "preview" })).toThrow(
      "DATABASE_URL_UNPOOLED or DATABASE_URL is required for Prisma on Vercel."
    );
  });

  it("uses an inert non-local URL only for an explicit Vercel generate", () => {
    const generateUrl = resolvePrismaCliDatabaseUrl(
      { VERCEL_ENV: "preview" },
      { allowVercelGeneratePlaceholder: true }
    );

    expect(new URL(generateUrl).hostname).toBe("prisma-generate.invalid");
    expect(generateUrl).not.toContain("localhost");
  });
});
