import { describe, expect, it, vi } from "vitest";

import {
  buildCourseSupportCommandFailure,
  classifyCommandFailure,
  COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS,
  CourseSupportDatabaseEnvironmentError,
  requireExplicitCourseSupportDatabaseUrl,
  runWithExplicitCourseSupportDatabaseUrl
} from "../../../scripts/automation/course-support";

describe("course-support CLI database environment guard", () => {
  it.each([
    ["unset", {}],
    ["empty", { DATABASE_URL: "" }],
    ["whitespace", { DATABASE_URL: " \r\n\t" }],
    ["BOM-only", { DATABASE_URL: "\uFEFF \r\n" }]
  ])("rejects an %s explicit database URL", (_label, environment) => {
    expect(() => requireExplicitCourseSupportDatabaseUrl(environment)).toThrow(
      CourseSupportDatabaseEnvironmentError
    );
  });

  it("accepts and normalizes an explicitly configured database URL", async () => {
    const operation = vi.fn(async () => "accepted");

    await expect(
      runWithExplicitCourseSupportDatabaseUrl(
        { DATABASE_URL: "\uFEFF postgresql://db.example/teetimespot " },
        operation
      )
    ).resolves.toBe("accepted");
    expect(
      requireExplicitCourseSupportDatabaseUrl({
        DATABASE_URL: "\uFEFF postgresql://db.example/teetimespot "
      })
    ).toBe("postgresql://db.example/teetimespot");
    expect(operation).toHaveBeenCalledOnce();
  });

  it("stops before the Prisma-backed worker gate when configuration is absent", async () => {
    const prismaWorkerGate = vi.fn(async () => true);

    await expect(
      runWithExplicitCourseSupportDatabaseUrl({}, prismaWorkerGate)
    ).rejects.toBeInstanceOf(CourseSupportDatabaseEnvironmentError);
    expect(prismaWorkerGate).not.toHaveBeenCalled();
  });

  it("classifies the guard as an aggregate ENV blocker", () => {
    const error = new CourseSupportDatabaseEnvironmentError();
    const result = buildCourseSupportCommandFailure(error);

    expect(classifyCommandFailure(error.message)).toBe("blocked_env");
    expect(result).toMatchObject({
      outcome: "blocked_env",
      failureDomain: "ENV",
      failureClass: COURSE_SUPPORT_DATABASE_URL_FAILURE_CLASS,
      durableCloseoutRecorded: false,
      threadDisposition: "KEEP_VISIBLE"
    });
    expect(JSON.stringify(result)).not.toContain("postgresql://");
  });
});
