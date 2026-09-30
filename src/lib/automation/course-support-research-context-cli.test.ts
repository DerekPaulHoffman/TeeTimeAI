import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseCourseSupportResearchOptions,
  parseCourseSupportResearchSpecialistOptions,
  runConfiguredCommand,
} from "../../../scripts/automation/course-support";

describe("course-support research command arguments", () => {
  it("accepts only an owner-bound ordinal and an exact validation digest", () => {
    expect(parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "01", "--owner-thread", "thread-reference",
    ], false)).toEqual({ batchRef: "batch-reference", ordinal: 1, contextDigest: undefined });
    expect(parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "1", "--context-digest", "a".repeat(64),
    ], true)).toEqual({ batchRef: "batch-reference", ordinal: 1, contextDigest: "a".repeat(64) });
  });

  it("rejects URL overrides, duplicate fields, invalid ordinals, and malformed digests", () => {
    expect(() => parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "01", "--url", "https://other.example/",
    ], false)).toThrow("accepts only");
    expect(() => parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "01", "--ordinal", "02",
    ], false)).toThrow("only once");
    expect(() => parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "21",
    ], false)).toThrow("01 through 20");
    expect(() => parseCourseSupportResearchOptions([
      "--batch-ref", "batch-reference", "--ordinal", "01", "--context-digest", "short",
    ], true)).toThrow("64-character lowercase");
  });
});

describe("research specialist registration arguments", () => {
  afterEach(() => vi.unstubAllEnvs());
  const args = [
    "--batch-ref", "batch-reference", "--ordinal", "01",
    "--owner-thread", "current-owner", "--context-digest", "a".repeat(64),
    "--specialist-thread", "native-child-reference",
  ];

  it("accepts only a current owner, exact packet digest, ordinal, and child reference", () => {
    expect(parseCourseSupportResearchSpecialistOptions(args)).toEqual({
      batchRef: "batch-reference", ordinal: 1, contextDigest: "a".repeat(64),
      specialistThreadId: "native-child-reference",
    });
    expect(() => parseCourseSupportResearchSpecialistOptions([
      ...args.slice(0, 4), ...args.slice(6),
    ])).toThrow("explicit --owner-thread");
    expect(parseCourseSupportResearchSpecialistOptions([
      ...args.slice(0, -1), "/root/ambiguous_course_research",
    ]).specialistThreadId).toBe("/root/ambiguous_course_research");
  });

  it.each([
    ["--model", "gpt-6-astra"], ["--tokens", "100"], ["--observed-at", "2026-09-30"],
    ["--url", "https://other.example"], ["--specialist-thread", "another-child"],
  ])("rejects unauthorized or duplicate registration metadata: %s", (option, value) => {
    expect(() => parseCourseSupportResearchSpecialistOptions([...args, option, value]))
      .toThrow(option === "--specialist-thread" ? "only once" : "accepts only");
  });

  it.each([
    "https://example.com/thread", "someone@example.com", "a".repeat(129),
    "/root/child/../../other", "/root/Child", `/root/${Array(9).fill("child").join("/")}`,
  ])(
    "rejects private or oversized specialist references: %s", (value) => {
      expect(() => parseCourseSupportResearchSpecialistOptions([...args.slice(0, -1), value]))
        .toThrow("bounded native");
    },
  );

  it("requires native owner context and rejects an owner argument mismatch before database access", async () => {
    vi.stubEnv("CODEX_THREAD_ID", "");
    await expect(runConfiguredCommand({
      argv: ["register-research-specialist", ...args],
      isWorkerExecutionAllowed: async () => true,
      write: vi.fn(),
    })).rejects.toThrow("current native CODEX_THREAD_ID");
    vi.stubEnv("CODEX_THREAD_ID", "different-owner");
    await expect(runConfiguredCommand({
      argv: ["register-research-specialist", ...args],
      isWorkerExecutionAllowed: async () => true,
      write: vi.fn(),
    })).rejects.toThrow("does not match the current Codex task identity");
  });
});
