import { describe, expect, it } from "vitest";
import { readSimulatorFullRepair } from "./simulator-full-repair";
const directive = { version: 1, kind: "FAILED_LEARNER_FULL_REPAIR", failedJobId: "failed-job",
  learningSourceFingerprint: "a".repeat(64), offeringSourceFingerprint: "b".repeat(64), incidentId: "incident" };
describe("server-derived simulator full repair", () => {
  it("keeps learner and offering source fingerprints distinct", () => {
    expect(readSimulatorFullRepair(directive)).toEqual(directive);
  });
  it.each([null, { ...directive, kind: "RETRY_RESEARCH" }, { ...directive, failedJobId: "" },
    { ...directive, learningSourceFingerprint: "unknown" }, { ...directive, allowedActions: ["BYPASS_ACCESS"] },
    { ...directive, offeringSourceFingerprint: undefined }])("rejects malformed or expanded authority", value => {
    expect(readSimulatorFullRepair(value)).toBeNull();
  });
});
