import { describe, expect, it } from "vitest";
import { readDiscoveryControllerCheckpoint, verifyDiscoveryCandidate } from "../../../scripts/automation/course-discovery-worker.mjs";
import { publicHeaderDiagnosticCorsErrors, publicHeaderDiagnosticErrorKinds, publicHeaderDiagnosticFailureReasons,
  publicHeaderDiagnosticNativeFactKeys, publicHeaderFailureDiagnostic, publicHeaderFailureDiagnosticSchema } from "./public-header-diagnostic";

const fixture = () => publicHeaderFailureDiagnostic("HEADER_PROOF_REVOKED_AFTER_QUEUE", "OPTIONS", {
  authorization: "Bearer null", "x-api-key": "PRIVATE_KEY_SENTINEL", "access-control-request-method": "POST",
  "access-control-request-headers": "authorization,x-api-key",
}, null, { reason: "NATIVE_RECORD_NOT_CURRENT", nativeSourceFailed: true, nativeSourceLoadingFailedErrorKind: "ABORTED" });
const restore = (publicHeaderDiagnostic: unknown) => readDiscoveryControllerCheckpoint({ controller: { version: 1, officialUrl: "https://example.org/",
  observedNavigationUrls: [], lastFailure: { code: "DISCOVERY_REPLAY_INCOMPLETE", details: { reason: "PROVIDER_THROTTLED", diagnostic: {
    code: "HTTP_429", publicHeaderDiagnostic, earlierRequestFailure: { code: "CREDENTIAL_HEADERS", method: "OPTIONS", resourceType: "fetch", publicHeaderDiagnostic },
  } } } } }, "https://example.org/");

describe("strict public header facts in worker replay diagnostics", () => {
  it("retains current closed facts through real failure projection and checkpoint without changing primary priority", async () => {
    const facts = fixture(), hash = "a".repeat(64); let failure;
    try {
      await verifyDiscoveryCandidate({ job: { id: "job", leaseToken: "synthetic", deadlineAt: "2030-01-02T12:00:00Z" }, recipe: {},
        client: { candidate: async () => ({ recipeHash: hash, challenges: [{ id: "one", recipeHash: hash, input: {} }, { id: "two", recipeHash: hash, input: {} }] }) },
        executeRecipe: async () => ({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "STEP_TIMEOUT",
          diagnostic: { code: "STEP_TIMEOUT", publicHeaderDiagnostic: facts, earlierRequestFailure: { code: "CREDENTIAL_HEADERS", publicHeaderDiagnostic: facts } } } }) });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "DISCOVERY_REPLAY_INCOMPLETE", details: { reason: "STEP_TIMEOUT", diagnostic: { code: "STEP_TIMEOUT",
      publicHeaderDiagnostic: facts, earlierRequestFailure: { code: "CREDENTIAL_HEADERS", publicHeaderDiagnostic: facts } } } });
    const restored = restore(facts), diagnostic = restored.lastFailure.details.diagnostic;
    expect(diagnostic.publicHeaderDiagnostic).toEqual(facts); expect(diagnostic.earlierRequestFailure.publicHeaderDiagnostic).toEqual(facts);
    expect(restored.lastFailure.details.reason).toBe("PROVIDER_THROTTLED"); expect(diagnostic.code).toBe("HTTP_429");
    facts.nativeSourceFailed = false; expect(diagnostic.publicHeaderDiagnostic.nativeSourceFailed).toBe(true);
    expect(JSON.stringify(restored)).not.toContain("PRIVATE_KEY_SENTINEL");
  });

  it("agrees with every closed optional native fact and enum in the maintained schema", () => {
    const values = [fixture(), ...publicHeaderDiagnosticNativeFactKeys.flatMap(key => [true, false].map(value => ({ ...fixture(), [key]: value }))),
      ...publicHeaderDiagnosticErrorKinds.map(value => ({ ...fixture(), nativeSourceLoadingFailedErrorKind: value })),
      ...publicHeaderDiagnosticCorsErrors.map(value => ({ ...fixture(), nativeSourceLoadingFailedCorsError: value })),
      ...publicHeaderDiagnosticFailureReasons.map(value => ({ ...fixture(), privateProofFailureReason: value }))];
    for (const facts of values) {
      expect(publicHeaderFailureDiagnosticSchema.safeParse(facts).success).toBe(true);
      expect(restore(facts).lastFailure.details.diagnostic.publicHeaderDiagnostic).toEqual(facts);
    }
  });

  it.each([
    null, [], "PRIVATE_SENTINEL", {}, { ...fixture(), headers: { authorization: "PRIVATE_SENTINEL" } },
    { ...fixture(), headerCount: 129 }, { ...fixture(), headerCount: -1 }, { ...fixture(), requestedHeaderCount: 0.5 },
    { ...fixture(), authorizationShape: "Bearer actual-private-token" }, { ...fixture(), stage: "OTHER" },
    { ...fixture(), ordinaryPreflightMethod: "DELETE" }, { ...fixture(), requestedPreflightMethod: "get" },
    { ...fixture(), nativeSourceFailed: "true" }, { ...fixture(), nativeSourceLoadingFailedErrorKind: "PRIVATE_SENTINEL" },
    { ...fixture(), nativeSourceLoadingFailedCorsError: "PRIVATE_SENTINEL" }, { ...fixture(), privateProofFailureReason: "PRIVATE_SENTINEL" },
    Object.fromEntries(Object.entries(fixture()).filter(([key]) => key !== "cookiePresent")),
  ])("omits an invalid entire facts object at both levels, preserving primary status/reason (%j)", value => {
    expect(publicHeaderFailureDiagnosticSchema.safeParse(value).success).toBe(false);
    const restored = restore(value), diagnostic = restored.lastFailure.details.diagnostic;
    expect(diagnostic).not.toHaveProperty("publicHeaderDiagnostic"); expect(diagnostic.earlierRequestFailure).not.toHaveProperty("publicHeaderDiagnostic");
    expect(diagnostic.code).toBe("HTTP_429"); expect(restored.lastFailure.details.reason).toBe("PROVIDER_THROTTLED");
    expect(JSON.stringify(restored)).not.toContain("PRIVATE_SENTINEL");
  });
});
