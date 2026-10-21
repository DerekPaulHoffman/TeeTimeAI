import { describe, expect, it } from "vitest";
import { safeDiscoveryTurnFailure } from "../../../scripts/automation/course-discovery-diagnostics.mjs";

describe("discovery model failure diagnostics", () => {
  it("preserves a known model failure category without provider messages or identity", () => {
    expect(safeDiscoveryTurnFailure({ id: "private-turn", status: "failed", error: {
      codexErrorInfo: "rateLimitExceeded", message: "private request body", additionalDetails: "token=private",
      misalignment: { text: "private explanation" },
    } })).toEqual({ turnStatus: "failed", errorCategory: "rateLimitExceeded" });
  });

  it("keeps a bounded HTTP status and drops all other structured provider data", () => {
    const info = { responseTooManyFailedAttempts: { httpStatusCode: 503, url: "https://private.example/session/secret" } };
    const projected = safeDiscoveryTurnFailure({ status: "failed", error: { codexErrorInfo: info } });
    info.responseTooManyFailedAttempts.httpStatusCode = 401;
    expect(projected).toEqual({ turnStatus: "failed", errorCategory: "responseTooManyFailedAttempts", httpStatusCode: 503 });
  });

  it.each([0, -1, 99, 600, 65535, 200.5, "429", [429], null])("omits an invalid HTTP status %j", httpStatusCode => {
    expect(safeDiscoveryTurnFailure({ status: "failed", error: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode } } } }))
      .toEqual({ turnStatus: "failed", errorCategory: "httpConnectionFailed" });
  });

  it.each(["private-category", ["rateLimitExceeded"], { privateKey: "secret" },
    { httpConnectionFailed: { httpStatusCode: 503 }, responseStreamDisconnected: {} }, { httpConnectionFailed: "private" },
    { responseStreamConnectionFailed: [] }, null])("does not echo unknown, ambiguous or coerced categories %j", codexErrorInfo => {
    expect(safeDiscoveryTurnFailure({ status: "interrupted", error: { codexErrorInfo } })).toEqual({ turnStatus: "interrupted" });
  });

  it("does not return completed output or malformed statuses as failure evidence", () => {
    for (const turn of [null, [], { status: "completed", error: { codexErrorInfo: "other" } },
      { status: ["failed"] }, { status: "private-status" }]) expect(safeDiscoveryTurnFailure(turn)).toBeUndefined();
  });

  it("reports known non-steerable state without retaining its raw turn metadata", () => {
    expect(safeDiscoveryTurnFailure({ status: "inProgress", error: { codexErrorInfo: {
      activeTurnNotSteerable: { turnKind: "private", httpStatusCode: 500 },
    } } })).toEqual({ turnStatus: "inProgress", errorCategory: "activeTurnNotSteerable" });
  });
});
