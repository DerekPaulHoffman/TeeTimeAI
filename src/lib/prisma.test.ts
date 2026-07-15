import { describe, expect, it } from "vitest";

import { isLocalPostgresUrl } from "./prisma";

describe("Prisma runtime adapter selection", () => {
  it("uses the standard PostgreSQL adapter only for local database hosts", () => {
    expect(isLocalPostgresUrl("postgresql://user:pass@localhost:5432/app")).toBe(true);
    expect(isLocalPostgresUrl("postgresql://user:pass@127.0.0.1:55432/app")).toBe(true);
    expect(isLocalPostgresUrl("postgresql://user:pass@example.neon.tech/app")).toBe(false);
    expect(isLocalPostgresUrl("not-a-url")).toBe(false);
  });
});
