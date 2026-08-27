import { describe, expect, it } from "vitest";

import {
  buildCourseSupportActionExecution,
  parseCourseSupportActionExecution,
} from "./course-support-action-execution";

const emptyProof = {
  strictImplementationProofRecorded: false,
  authoritativeSuccessSuperseded: false,
  materialChangeSuperseded: false,
  authoritativeTerminalResultSuperseded: false,
  currentRuntimeProofRecorded: false,
  currentClassificationProofRecorded: false,
};

describe("course-support action execution", () => {
  it("requires strict runtime release and deployment proof for implementation execution", () => {
    expect(
      buildCourseSupportActionExecution({
        ...emptyProof,
        action: "IMPLEMENT_REUSABLE_SUPPORT",
        strictImplementationProofRecorded: true,
      }),
    ).toEqual({
      schemaVersion: 1,
      action: "IMPLEMENT_REUSABLE_SUPPORT",
      state: "EXECUTED",
      reason: "STRICT_RUNTIME_RELEASE_DEPLOYMENT_PROOF",
    });
    expect(
      buildCourseSupportActionExecution({
        ...emptyProof,
        action: "IMPLEMENT_REUSABLE_SUPPORT",
      }),
    ).toEqual({
      schemaVersion: 1,
      action: "IMPLEMENT_REUSABLE_SUPPORT",
      state: "NOT_EXECUTED",
      reason: "IMPLEMENTATION_PROOF_MISSING",
    });
  });

  it("distinguishes authoritative success and material-change supersession", () => {
    expect(
      buildCourseSupportActionExecution({
        ...emptyProof,
        action: "IMPLEMENT_REUSABLE_SUPPORT",
        authoritativeSuccessSuperseded: true,
      }).reason,
    ).toBe("SUPERSEDED_BY_AUTHORITATIVE_SUCCESS");
    expect(
      buildCourseSupportActionExecution({
        ...emptyProof,
        action: "IMPLEMENT_REUSABLE_SUPPORT",
        materialChangeSuperseded: true,
      }).reason,
    ).toBe("SUPERSEDED_BY_MATERIAL_CHANGE");
  });

  it("derives verification and classification only from exact current proof", () => {
    expect(
      buildCourseSupportActionExecution({
        ...emptyProof,
        action: "VERIFY_CURRENT_RUNTIME",
        currentRuntimeProofRecorded: true,
      }),
    ).toMatchObject({
      state: "EXECUTED",
      reason: "CURRENT_RUNTIME_PROOF_RECORDED",
    });
    expect(
      buildCourseSupportActionExecution({
        ...emptyProof,
        action: "VERIFY_CURRENT_RUNTIME",
      }),
    ).toMatchObject({
      state: "NOT_EXECUTED",
      reason: "CURRENT_RUNTIME_PROOF_MISSING",
    });
    expect(
      buildCourseSupportActionExecution({
        ...emptyProof,
        action: "COMPLETE_CLASSIFICATION",
        currentClassificationProofRecorded: true,
      }),
    ).toMatchObject({
      state: "EXECUTED",
      reason: "CURRENT_CLASSIFICATION_PROOF_RECORDED",
    });
  });

  it("leaves actions without exact markers unavailable", () => {
    expect(
      buildCourseSupportActionExecution({
        ...emptyProof,
        action: "SEARCH_FOR_OFFICIAL_SOURCE",
      }),
    ).toMatchObject({
      state: "UNAVAILABLE",
      reason: "EXACT_ACTION_MARKER_UNAVAILABLE",
    });
    expect(
      buildCourseSupportActionExecution({
        ...emptyProof,
        action: "INSPECT_PROVIDER_CONTRACT",
      }),
    ).toMatchObject({
      state: "UNAVAILABLE",
      reason: "EXACT_ACTION_MARKER_UNAVAILABLE",
    });
  });

  it("rejects malformed or semantically impossible persisted markers", () => {
    expect(
      parseCourseSupportActionExecution({
        schemaVersion: 1,
        action: "IMPLEMENT_REUSABLE_SUPPORT",
        state: "EXECUTED",
        reason: "SUPERSEDED_BY_AUTHORITATIVE_SUCCESS",
      }),
    ).toBeNull();
    expect(
      parseCourseSupportActionExecution({
        schemaVersion: 1,
        action: "VERIFY_CURRENT_RUNTIME",
        state: "EXECUTED",
        reason: "CURRENT_RUNTIME_PROOF_RECORDED",
        extra: true,
      }),
    ).toBeNull();
  });
});
