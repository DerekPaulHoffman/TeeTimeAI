// @vitest-environment node
import { describe, expect, it } from "vitest";
import { hasConsumedIncompletePlaybookContinuation } from "./course-support-campaign";

const receipt = {
  eventType: "REVALIDATION_REQUESTED",
  source: "COURSE_SUPPORT_RESPONDER",
  audit: {
    action: "parked_cohort_incomplete_playbook_recovery",
    campaignRunId: "campaign-1",
    cycle: 4,
    playbookNextStage: "OFFICIAL_HTTP_DISCOVERY",
    playbookStageAttemptCount: 1,
    runtimeVersion: "old-release",
  },
};
const current = { campaignRunId: "campaign-1", cycle: 4, stage: "OFFICIAL_HTTP_DISCOVERY", attemptCount: 1 };

describe("unfinished stage continuation consumption", () => {
  it.each(["parked_cohort_incomplete_playbook_recovery", "parked_cohort_unfinished_stage_continuation"])("keeps an unchanged stage consumed across a release: %s", (action) => {
    expect(hasConsumedIncompletePlaybookContinuation({ ...current, events: [{ ...receipt, audit: { ...receipt.audit, action } }] })).toBe(true);
    expect(hasConsumedIncompletePlaybookContinuation({ ...current, events: [{ ...receipt, audit: { ...receipt.audit, runtimeVersion: "new-release" } }] })).toBe(true);
  });
  it.each([{ attemptCount: 2 }, { stage: "HTTP_ADAPTER_RETRY" }, { cycle: 5 }])(
    "allows a genuinely different stage attempt: %j", (change) => {
      expect(hasConsumedIncompletePlaybookContinuation({ ...current, ...change, events: [receipt] })).toBe(false);
    },
  );
  it("preserves a legacy receipt that omitted the attempt count", () => {
    const { playbookStageAttemptCount, ...audit } = receipt.audit;
    void playbookStageAttemptCount;
    expect(hasConsumedIncompletePlaybookContinuation({ ...current, attemptCount: 2, events: [{ ...receipt, audit }] })).toBe(true);
    expect(hasConsumedIncompletePlaybookContinuation({ ...current, stage: "HTTP_ADAPTER_RETRY", events: [{ ...receipt, audit }] })).toBe(false);
  });
  it("does not invent renewed permission when a legacy receipt omitted the stage", () => {
    const { playbookStageAttemptCount, playbookNextStage, ...audit } = receipt.audit;
    void playbookStageAttemptCount;
    void playbookNextStage;
    expect(hasConsumedIncompletePlaybookContinuation({ ...current, stage: "HTTP_ADAPTER_RETRY", events: [{ ...receipt, audit }] })).toBe(true);
  });
});
