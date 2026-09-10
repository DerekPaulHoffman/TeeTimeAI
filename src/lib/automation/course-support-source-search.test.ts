import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import type { CourseSupportClaimActionPlan } from "./course-support-action-plan";

import {
  buildCourseSupportSourceSearchAttemptRef,
  buildCourseSupportRetainedSourceSearchKey,
  buildCourseSupportSourceSearchContext,
  buildCourseSupportSourceSearchScopeDigest,
  getCourseSupportSourceQueryChange,
  normalizeCourseSupportSourceSearchResult,
} from "./course-support-source-search";

describe("course-support exact source search", () => {
  it("proves a query capability change only for an unchanged identity's obsolete negative result", () => {
    const identity = { name: "Pine Ridge Golf Course", address: "10 Main Street", city: "Springfield", stateCode: "MA" };
    const priorQueryDigest = createHash("sha256")
      .update('"pine ridge golf course" "10 main street" "springfield, ma" "official golf course"').digest("hex");
    const input = { identity, priorResult: "NO_UNIQUE", priorQueryDigest };
    const proof = getCourseSupportSourceQueryChange(input);
    expect(proof).toEqual({ priorRecipe: "QUOTED_IDENTITIES_V1", currentRecipe: "IDENTITY_TERMS_V2",
      priorQueryDigest, currentQueryDigest: buildCourseSupportSourceSearchContext(identity).queryDigest });
    expect(getCourseSupportSourceQueryChange({ ...input, priorResult: "CANDIDATE" })).toBeNull();
    expect(getCourseSupportSourceQueryChange({ ...input, priorQueryDigest: proof!.currentQueryDigest })).toBeNull();
    expect(getCourseSupportSourceQueryChange({ ...input, priorQueryDigest: "unproven" })).toBeNull();
    expect(getCourseSupportSourceQueryChange({ ...input, identity: { ...identity, address: "12 Main Street" } })).toBeNull();
    expect(getCourseSupportSourceQueryChange({ ...input, identity: { ...identity, city: "Another Town" } })).toBeNull();
  });

  it("binds retained-source research to the incident, cycle and rejected evidence, not a new owner", () => {
    const scope = { incidentId: "incident-source", cycle: 2, rejectionEvidenceDigest: "a".repeat(64) };
    const key = buildCourseSupportRetainedSourceSearchKey(scope);
    expect(buildCourseSupportRetainedSourceSearchKey({ ...scope })).toBe(key);
    expect(key).toMatch(/^course-support-retained-source-search:[a-f0-9]{64}$/u);
    expect(buildCourseSupportRetainedSourceSearchKey({ ...scope, cycle: 3 })).not.toBe(key);
    expect(buildCourseSupportRetainedSourceSearchKey({ ...scope, incidentId: "different-incident" })).not.toBe(key);
    expect(buildCourseSupportRetainedSourceSearchKey({ ...scope, rejectionEvidenceDigest: "b".repeat(64) })).not.toBe(key);
    expect(() => buildCourseSupportRetainedSourceSearchKey({ ...scope, cycle: 0 })).toThrow();
    expect(() => buildCourseSupportRetainedSourceSearchKey({ ...scope, rejectionEvidenceDigest: "UNKNOWN" })).toThrow();
  });
  it("preserves the released action-plan-bound ownership digest", () => {
    const scope = { batchId: "batch-source", incidentId: "incident-source", cycle: 2 };
    const plan: CourseSupportClaimActionPlan = {
      schemaVersion: 1,
      primaryAction: "SEARCH_FOR_OFFICIAL_SOURCE",
      allowedActions: ["SEARCH_FOR_OFFICIAL_SOURCE"],
      route: {
        workMode: "ADVANCE_DISCOVERY",
        strategyAction: "DISCOVER_WITH_BROWSER",
        playbookStage: "RENDERED_BROWSER_DISCOVERY",
      },
    };
    const legacy = buildCourseSupportSourceSearchScopeDigest(scope);
    const releasedWriterDigest = createHash("sha256")
      .update(legacy)
      .update("\0")
      .update(JSON.stringify(plan))
      .digest("hex");
    expect(buildCourseSupportSourceSearchScopeDigest({ ...scope, actionPlan: plan }))
      .toBe(releasedWriterDigest);
    expect(releasedWriterDigest).not.toBe(legacy);
    expect(buildCourseSupportSourceSearchScopeDigest({ ...scope, actionPlan: null }))
      .toBe(legacy);
    expect(buildCourseSupportSourceSearchScopeDigest({
      ...scope,
      actionPlan: { ...plan, allowedActions: [...plan.allowedActions, "VERIFY_CURRENT_RUNTIME"] },
    })).not.toBe(releasedWriterDigest);
  });

  it("builds one deterministic name, address, and locality query without mandatory phrases", () => {
    const context = buildCourseSupportSourceSearchContext({
      name: "  Pine   Ridge “Golf” Course ",
      address: "10 Main Street",
      city: "Springfield",
      stateCode: "ma",
    });

    expect(context.query).toBe(
      "Pine Ridge Golf Course 10 Main Street Springfield MA official golf course",
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
      query: "Pine Ridge Golf Course Springfield MA official golf course",
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
      query: "Pine Ridge Golf Course official golf course",
      missingIdentityFields: ["ADDRESS", "CITY", "STATE"],
    });
  });

  it("uses historical full-address shapes as search terms and removes query-control punctuation", () => {
    const context = buildCourseSupportSourceSearchContext({
      name: 'Lakeside Golf Club and Event Center "site:example.com"',
      address: "4825 Lake Dr, Pleasant Hill, IA 50327, USA",
      city: "Pleasant Hill",
      stateCode: "IA",
    });
    expect(context.query).toBe(
      "Lakeside Golf Club and Event Center site example com 4825 Lake Dr Pleasant Hill IA 50327 USA Pleasant Hill IA official golf course",
    );
    expect(context.query).not.toMatch(/[":]/u);
    expect(context.missingIdentityFields).toEqual([]);
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
