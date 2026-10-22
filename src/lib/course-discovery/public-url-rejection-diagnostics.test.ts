import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describePublicUrlRejection, safePublicUrlRejectionDiagnostic } from "../../../scripts/automation/course-discovery-diagnostics.mjs";
import { isSafeBrowserAssetUrl, isSafeRecipeUrl } from "./recipe";

const base = "https://publicgolf.cps.golf/onlineres/onlineapi/api/v1/onlinereservation/GetAllOptions/publicgolf";
const validators = { recipe: isSafeRecipeUrl, asset: isSafeBrowserAssetUrl };
const read = (url: string, checked = url) => describePublicUrlRejection(url, checked, "GET", "xhr", "BROWSER_REQUEST_URL", validators)!;

describe("bounded rejected URL diagnostics", () => {
  it("distinguishes rejected query state from a valid CPS bootstrap path without exposing values", () => {
    const url = `${base}?version=25.3.4.21239412485&product=3&api_key=DiagnosticExample1234567890#private-fragment`;
    expect(isSafeRecipeUrl(url)).toBe(false);
    const diagnostic = read(url);
    expect(diagnostic).toMatchObject({ originalUrlSha256: createHash("sha256").update(url).digest("hex"),
      checkedUrlSha256: createHash("sha256").update(url).digest("hex"), method: "GET", resourceType: "xhr",
      stage: "BROWSER_REQUEST_URL", validatorCategory: "PUBLIC_RECIPE_OR_STATIC_ASSET", queryParseStatus: "PARSED",
      queryCount: 3, queryFreeValidation: "PASSED", queryFreeRecipeValid: true, queryFreeAssetValid: false,
      queryKeys: [{ key: "version", occurrences: 1, valueClasses: ["DOTTED_VERSION"] },
        { key: "product", occurrences: 1, valueClasses: ["INTEGER"] },
        { key: "api_key", occurrences: 1, valueClasses: ["OPAQUE_LIKE"] }] });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|DiagnosticExample|25\.3|publicgolf|https:|fragment/);
    expect(isSafeRecipeUrl(url)).toBe(false);
  });
  it("retains duplicate names and closed value categories while hiding arbitrary key bytes", () => {
    const url = `${base}?parentName=public&parentName=&date=2026-10-23&players=2&state=true&code=https%3A%2F%2Fprivate.example%2Fsecret&privateCredentialName=private`;
    const diagnostic = read(url);
    expect(diagnostic.queryCount).toBe(7);
    expect(diagnostic.queryKeys).toEqual([{ key: "parentname", occurrences: 2, valueClasses: ["TEXT", "EMPTY"] },
      { key: "date", occurrences: 1, valueClasses: ["LOCAL_DATE"] }, { key: "players", occurrences: 1, valueClasses: ["INTEGER"] },
      { key: "state", occurrences: 1, valueClasses: ["BOOLEAN"] }, { key: "code", occurrences: 1, valueClasses: ["URL_LIKE"] },
      { key: "OTHER", occurrences: 1, valueClasses: ["TEXT"] }]);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private|2026|publicgolf|secret/);
  });
  it("bounds query expansion and distinguishes an unevaluated URL from an empty query", () => {
    const diagnostic = read(`${base}?version=${"x".repeat(9000)}`);
    expect(diagnostic).toMatchObject({ queryParseStatus: "LIMIT", queryCount: null, queryKeys: [], queryTruncated: true,
      queryFreeValidation: "UNAVAILABLE" });
    expect(read("invalid private URL")).toMatchObject({ queryParseStatus: "INVALID", queryCount: null, queryFreeValidation: "UNAVAILABLE" });
    expect(read(base)).toMatchObject({ queryParseStatus: "PARSED", queryCount: 0, queryFreeValidation: "PASSED" });
  });
  it("revalidates the query-free host/path and records unavailable validator outcomes honestly", () => {
    expect(read(base.replace("publicgolf.cps.golf", "127.0.0.1"))).toMatchObject({ queryFreeValidation: "REJECTED" });
    expect(read(base.replace("GetAllOptions/publicgolf", "Account/Login"))).toMatchObject({ queryFreeValidation: "REJECTED" });
    const diagnostic = describePublicUrlRejection(base, base, "GET", "xhr", "PINNED_TRANSPORT_URL", {
      recipe() { throw new Error("private"); }, asset: isSafeBrowserAssetUrl });
    expect(diagnostic).toMatchObject({ stage: "PINNED_TRANSPORT_URL", queryFreeValidation: "UNAVAILABLE" });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
  });
  it("copies only closed fields and prevents supplied classification or URL text from escaping", () => {
    const original = read(`${base}?version=1.2.3`);
    const value = { ...original, rawUrl: "private", body: "private", queryFreeValidation: "PASSED",
      queryFreeRecipeValid: "true", queryFreeAssetValid: true, queryKeys: Array(30).fill({ key: "private", occurrences: 99999,
        valueClasses: ["private", "TEXT"], value: "private" }) };
    const safe = safePublicUrlRejectionDiagnostic(value)!;
    expect(safe.queryFreeValidation).toBe("UNAVAILABLE");
    expect(safe.queryKeys).toHaveLength(16);
    expect(safe.queryTruncated).toBe(true);
    expect(safe.queryKeys[0]).toEqual({ key: "OTHER", occurrences: 1, valueClasses: ["TEXT"] });
    expect(JSON.stringify(safe)).not.toContain("private");
    safe.queryKeys[0].valueClasses.push("EMPTY");
    expect(value.queryKeys[0].valueClasses).toEqual(["private", "TEXT"]);
    for (const changed of [{ stage: "private" }, { originalUrlSha256: [original.originalUrlSha256] },
      { checkedUrlSha256: "private" }, { validatorCategory: "private" }])
      expect(safePublicUrlRejectionDiagnostic({ ...original, ...changed })).toBeUndefined();
  });
});
