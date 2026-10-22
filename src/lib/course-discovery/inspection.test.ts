// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseLearningInspectionArgs, summarizeLearningJob } from "./inspection";

describe("read-only course learning receipt", () => {
  it("reports the response browser engine and transport without exposing its extraction payload", () => {
    const now = new Date("2030-01-01T12:00:00Z");
    const summary = summarizeLearningJob({ job: { id: "job-a", courseId: "course-a", offeringId: "offering-a", status: "SUCCEEDED", attempts: 1,
      createdAt: now, firstPickedUpAt: now, deadlineAt: now, completedAt: now, request: {}, result: {} },
      activatedRecipe: { id: "recipe-a", version: 1, hash: "a".repeat(64), payload: { engine: "BROWSER_JSON", browserTransport: "NATIVE_CHROME",
        responseRows: { accessIdPath: "DO_NOT_OUTPUT" }, source: { bookingUrl: "DO_NOT_OUTPUT" } } }, activeRecipeId: "recipe-a", executions: [], deliveries: [],
      targetMatchIds: [], observedAt: now, evidenceSince: now, executionsTruncated: false, deliveriesTruncated: false });
    expect(summary.activatedRecipe).toMatchObject({ engine: "BROWSER_JSON", browserTransport: "NATIVE_CHROME", currentlyActive: true });
    expect(JSON.stringify(summary)).not.toContain("DO_NOT_OUTPUT");
  });
  it("bounds requests and accepts exact stable job IDs", () => {
    expect(parseLearningInspectionArgs(["--hours", "72", "--limit", "1", "--job-id", "job-a", "--job-id", "job-b"]))
      .toEqual({ hours: 72, limit: 2, jobIds: ["job-a", "job-b"] });
    for (const args of [["--hours", "73"], ["--limit", "31"], ["--limit", "0"], ["--job-id", "https://secret"], ["--reset", "yes"]]) {
      expect(() => parseLearningInspectionArgs(args)).toThrow();
    }
  });

  it.each(["MATCH", "SETUP", "DAILY", "MONITORING_STATUS_UPDATE"])("counts matching %s email and excludes empty setup, wrong target and wrong generation", kind => {
    const start = new Date("2030-01-01T12:00:00Z"); const accepted = new Date("2030-01-01T12:08:00Z"); const now = new Date("2030-01-01T12:10:00Z");
    const job = { id: "job-a", courseId: "course-a", offeringId: null, status: "SUCCEEDED", attempts: 2, createdAt: start,
      firstPickedUpAt: start, completedAt: accepted, deadlineAt: new Date("2030-01-01T12:15:00Z"),
      request: { demand: { searchId: "search-a", alertGeneration: 2 }, secret: "DO_NOT_OUTPUT" }, result: { recipeId: "recipe-a", secret: "DO_NOT_OUTPUT" } };
    const delivery = { id: "delivery-a", status: "SENT", kind, alertGeneration: 2, sentAt: accepted, isOwnerRecipient: true,
      payload: { matchIds: ["target-match"], email: "DO_NOT_OUTPUT", url: "https://secret.invalid/?token=DO_NOT_OUTPUT" } };
    const summary = summarizeLearningJob({ job, activatedRecipe: { id: "recipe-a", version: 2, hash: "a".repeat(64),
      payload: { engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME", source: { bookingUrl: "DO_NOT_OUTPUT" } } }, activeRecipeId: "recipe-a",
      executions: [{ id: "warm-a", status: "COMPLETED", claimedAt: accepted, completedAt: accepted, jobExpiresAt: now,
        resultExpiresAt: new Date(now.getTime() + 1000), sourceContext: { recipeId: "recipe-a", leaseToken: "DO_NOT_OUTPUT" }, result: { status: "AVAILABLE", raw: "DO_NOT_OUTPUT" } }],
      deliveries: [delivery, { ...delivery, id: "empty-setup", kind: "SETUP", payload: { matchIds: [] } },
        { ...delivery, id: "wrong-generation", alertGeneration: 1 }, { ...delivery, id: "wrong-target", payload: { matchIds: ["other-match"] } }],
      targetMatchIds: ["target-match"], observedAt: now, evidenceSince: start, executionsTruncated: false, deliveriesTruncated: false });
    expect(summary.matchDelivery).toMatchObject({ channel: "MATCHING_EMAIL", evidence: "PROVIDER_ACCEPTED_NOT_INBOX", acceptedCount: 1,
      ownerAcceptedAt: accepted.toISOString(), pickupToOwnerAcceptedMs: 480_000 });
    expect(summary.activatedRecipe).toMatchObject({ version: 2, engine: "BROWSER_DOM", browserTransport: "NATIVE_CHROME", currentlyActive: true });
    expect(summary.warmExecutions[0].fresh).toBe(true);
    expect(JSON.stringify(summary)).not.toContain("DO_NOT_OUTPUT");
  });
  it.each([
    ["12:14:00", "12:14:00", "WITHIN_DEADLINE"],
    ["12:16:00", "12:17:00", "AFTER_DEADLINE"],
    [null, "12:14:00", "WAITING"],
    [null, "12:17:00", "MISSED"],
  ])("reports the original pickup deadline independently of recipe activation (%s)", (sentTime, observedTime, expected) => {
    const date = (time: string) => new Date(`2030-01-01T${time}Z`);
    const start = date("12:00:00");
    const summary = summarizeLearningJob({ job: { id: "job-a", courseId: "course-a", offeringId: null, status: "SUCCEEDED", attempts: 1,
      createdAt: start, firstPickedUpAt: start, deadlineAt: date("12:15:00"), completedAt: date("12:01:00"),
      request: { demand: { searchId: "search-a", alertGeneration: 1 } }, result: {} },
      activatedRecipe: null, activeRecipeId: null, executions: [], deliveries: sentTime ? [{ id: "delivery-a", status: "SENT", kind: "MATCH",
        alertGeneration: 1, sentAt: date(sentTime), isOwnerRecipient: true, payload: { matchIds: ["match-a"] } }] : [],
      targetMatchIds: ["match-a"], observedAt: date(observedTime!), evidenceSince: start, executionsTruncated: false, deliveriesTruncated: false });
    expect(summary.matchDelivery.ownerAcceptanceTiming).toBe(expected);
    expect(summary.matchDelivery.evidence).toBe("PROVIDER_ACCEPTED_NOT_INBOX");
  });
});
