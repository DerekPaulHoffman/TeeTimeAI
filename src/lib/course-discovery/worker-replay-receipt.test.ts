import { describe, expect, it, vi } from "vitest";
import { DISCOVERY_CONFIG, DISCOVERY_MODEL, discoveryReplayDetails, restrictedModelCatalog, verifyDiscoveryCandidate } from "../../../scripts/automation/course-discovery-worker.mjs";

const hash = "a".repeat(64);
function proofClient() {
  return { candidate: vi.fn(async () => ({ recipeHash: hash, challenges: [
    { id: "first", recipeHash: hash, input: { players: 2 } },
    { id: "second", recipeHash: hash, input: { players: 3 } },
  ] })), verification: vi.fn(async () => ({})), activate: vi.fn(async () => ({})) };
}
const job = { id: "owned-job", leaseToken: "private-lease", deadlineAt: "2030-01-02T12:00:00Z" };

describe("independent replay receipts", () => {
  it("pins the requested Sol model, ChatGPT sign-in and a consistent reasoning effort with no model fallback", () => {
    expect(DISCOVERY_MODEL).toBe("gpt-6.1-sol");
    expect(DISCOVERY_CONFIG).toMatchObject({ forced_login_method: "chatgpt", model_reasoning_effort: "medium" });
    const catalog = { models: [{ slug: DISCOVERY_MODEL }, { slug: "gpt-6-astra" }] };
    expect(restrictedModelCatalog(catalog).models.map(model => model.slug)).toEqual([DISCOVERY_MODEL]);
    expect(() => restrictedModelCatalog(catalog, "gpt-6-astra")).toThrow("DISCOVERY_MODEL_NOT_ALLOWED");
    expect(() => restrictedModelCatalog({ models: [{ slug: "gpt-6-astra" }] })).toThrow("DISCOVERY_MODEL_UNAVAILABLE");
  });

  it("reports the exact incomplete identity reason before any proof write without exposing provider payloads", async () => {
    const client = proofClient(), onReplay = vi.fn();
    const executeRecipe = vi.fn(async () => ({ status: "INCOMPLETE", complete: false, slots: [],
      sourceUrl: "https://provider.example/?secret=private", evidence: { reason: "ADAPTER_IDENTITY_MISMATCH", raw: "private-provider-body" } }));
    const error = await verifyDiscoveryCandidate({ client, job, recipe: {}, executeRecipe, onReplay }).catch(value => value);
    expect(error).toMatchObject({ code: "DISCOVERY_REPLAY_INCOMPLETE", details: {
      status: "INCOMPLETE", complete: false, reason: "ADAPTER_IDENTITY_MISMATCH", slotCount: 0,
      proof: { venueVerified: false, dateVerified: false, capacityVerified: false, durationVerified: false, completeVerified: false },
    } });
    expect(onReplay).toHaveBeenCalledWith({ elapsedMs: expect.any(Number), challengeIndex: 0, result: error.details });
    expect(JSON.stringify(onReplay.mock.calls)).not.toMatch(/secret|provider.example|private/);
    expect(client.verification).not.toHaveBeenCalled();
    expect(client.activate).not.toHaveBeenCalled();
    expect(executeRecipe).toHaveBeenCalledOnce();
  });

  it("retains the primary thrown cancellation and a safe failure receipt", async () => {
    const client = proofClient(), onReplay = vi.fn();
    const cancellation = Object.assign(new Error("private transport prose"), { code: "DISCOVERY_CANCELLED" });
    await expect(verifyDiscoveryCandidate({ client, job, recipe: {}, onReplay,
      executeRecipe: async () => { throw cancellation; } })).rejects.toBe(cancellation);
    expect(onReplay).toHaveBeenCalledWith({ elapsedMs: expect.any(Number), challengeIndex: 0,
      result: expect.objectContaining({ status: "FAILED", complete: false, reason: "DISCOVERY_CANCELLED" }) });
    expect(JSON.stringify(onReplay.mock.calls)).not.toContain("private");
    expect(client.verification).not.toHaveBeenCalled();
    expect(client.activate).not.toHaveBeenCalled();
  });

  it("still executes and verifies both independently issued inputs before activation", async () => {
    const client = proofClient(), onReplay = vi.fn(), signal = new AbortController().signal;
    const executeRecipe = vi.fn(async () => ({ status: "EMPTY", complete: true, slots: [], evidence: {} }));
    await verifyDiscoveryCandidate({ client, job, recipe: {}, signal, executeRecipe, onReplay });
    expect(executeRecipe.mock.calls).toEqual([
      [{ recipe: {}, input: { players: 2 }, deadlineAt: job.deadlineAt, signal }],
      [{ recipe: {}, input: { players: 3 }, deadlineAt: job.deadlineAt, signal }],
    ]);
    expect(client.verification).toHaveBeenCalledTimes(2);
    expect(client.activate).toHaveBeenCalledOnce();
    expect(onReplay.mock.calls.map(([value]) => [value.challengeIndex, value.result.complete, value.result.reason]))
      .toEqual([[0, true, "REPLAY_COMPLETE"], [1, true, "REPLAY_COMPLETE"]]);
  });

  it("does not upgrade an invalid status or arbitrary reason to a complete proof", () => {
    expect(discoveryReplayDetails({ status: "UNSUPPORTED", complete: true, slots: Array(501), evidence: { reason: "private prose" } }))
      .toMatchObject({ status: "FAILED", complete: false, reason: "UNVERIFIED_REPLAY", slotCount: 500 });
  });
});
