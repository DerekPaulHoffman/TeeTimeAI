import { describe, expect, it } from "vitest";

import {
  buildCourseSupportSourceSearchAttemptRef,
  buildCourseSupportSourceSearchContext,
  buildCourseSupportSourceSearchScopeDigest,
  normalizeCourseSupportSourceSearchResult,
} from "./course-support-source-search";

describe("course-support exact source search", () => {
  it("builds one deterministic exact name, address, and locality query", () => {
    const context = buildCourseSupportSourceSearchContext({
      name: "  Pine   Ridge “Golf” Course ",
      address: "10 Main Street",
      city: "Springfield",
      stateCode: "ma",
    });

    expect(context.query).toBe(
      '"Pine Ridge Golf Course" "10 Main Street" "Springfield, MA" "official golf course"',
    );
    expect(context.queryDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(context.missingIdentityFields).toEqual([]);
    expect(
      buildCourseSupportSourceSearchContext({
        name: "Pine Ridge Golf Course",
        address: "10 Main Street",
        city: "Springfield",
        stateCode: "MA",
      }).queryDigest,
    ).toBe(context.queryDigest);
  });

  it("builds a bounded best-available query when location fields are absent", () => {
    expect(
      buildCourseSupportSourceSearchContext({
        name: "Pine Ridge Golf Course",
        address: null,
        city: "Springfield",
        stateCode: "MA",
      }),
    ).toMatchObject({
      query: '"Pine Ridge Golf Course" "Springfield, MA" "official golf course"',
      missingIdentityFields: ["ADDRESS"],
    });
    expect(
      buildCourseSupportSourceSearchContext({
        name: "Pine Ridge Golf Course",
        address: null,
        city: null,
        stateCode: null,
      }),
    ).toMatchObject({
      query: '"Pine Ridge Golf Course" "official golf course"',
      missingIdentityFields: ["ADDRESS", "CITY", "STATE"],
    });
  });

  it("still fails closed when the course name is absent", () => {
    expect(() =>
      buildCourseSupportSourceSearchContext({
        name: "   ",
        address: "10 Main Street",
        city: "Springfield",
        stateCode: "MA",
      }),
    ).toThrow("current course name");
  });

  it("accepts one direct safe candidate and removes only its fragment", () => {
    expect(
      normalizeCourseSupportSourceSearchResult({
        candidateUrl:
          "https://parks.example.gov/golf/pine-ridge?source=directory#hours",
      }),
    ).toEqual({
      result: "CANDIDATE",
      candidateUrl:
        "https://parks.example.gov/golf/pine-ridge?source=directory",
    });
  });

  it.each([
    "https://www.google.com/search?q=pine+ridge+golf",
    "https://www.google.co.uk/search?q=pine+ridge+golf",
    "https://maps.google.ca/?q=pine+ridge+golf",
    "https://duckduckgo.com/?q=pine+ridge+golf",
    "https://uk.search.yahoo.com/search?p=pine+ridge+golf",
    "https://r.search.yahoo.co.jp/course",
    "https://bit.ly/course",
    "http://127.0.0.1/course",
    "https://user:secret@example.com/course",
  ])(
    "rejects a search result, redirector, private host, or credential URL",
    (candidateUrl) => {
      expect(() =>
        normalizeCourseSupportSourceSearchResult({ candidateUrl }),
      ).toThrow("direct safe public URL");
    },
  );

  it("records NO_UNIQUE without accepting a candidate payload", () => {
    expect(
      normalizeCourseSupportSourceSearchResult({ noUnique: true }),
    ).toEqual({
      result: "NO_UNIQUE",
      candidateUrl: null,
    });
    expect(() =>
      normalizeCourseSupportSourceSearchResult({
        noUnique: true,
        candidateUrl: "https://course.example/",
      }),
    ).toThrow("exactly one");
  });

  it("builds opaque deterministic ownership and snapshot references", () => {
    const scopeDigest = buildCourseSupportSourceSearchScopeDigest({
      batchId: "batch-1",
      incidentId: "incident-1",
      cycle: 2,
    });
    const attemptRef = buildCourseSupportSourceSearchAttemptRef({
      scopeDigest,
      queryDigest: "a".repeat(64),
      courseUpdatedAt: new Date("2026-08-20T12:00:00.000Z"),
    });

    expect(scopeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(attemptRef).toMatch(/^[a-f0-9]{64}$/u);
    expect(attemptRef).not.toContain("batch-1");
  });
});
