import { describe, expect, it } from "vitest";
import { assertSimulatorSupportDeployment, createSimulatorSupportIntentDigest, isCurrentSimulatorSupportSource, validateSimulatorSupportPath, type SimulatorSupportSource } from "./simulator-support-policy";
import { readSimulatorSupportArguments } from "../../../scripts/automation/simulator-support";
import { summarizeSimulatorSupportPublicHtml } from "./simulator-support-ownership";

const now = new Date("2026-10-06T15:00:00Z");
function source(): SimulatorSupportSource { return {
  id: "search", mode: "SIMULATOR", userId: "user", user: { id: "user", clerkUserId: "clerk", email: "owner@example.test", pendingEmail: null }, alertEmail: "owner@example.test", additionalEmails: [],
  date: new Date("2026-10-08T00:00:00Z"), startTime: "09:00", endTime: "18:00", userTimeZone: "UTC", players: 4, requestedLayoutHoles: null, durationMinutes: 60,
  cadenceMinutes: 15, trafficClass: "PUBLIC", syntheticMultiCycle: false, syntheticTestWindow: null, createdAt: now, status: "ACTIVE", scheduleVersion: 1, alertGeneration: 0,
  preferences: [{ courseId: "course", offeringId: "offering", rank: 1 }], checkStatus: "WAITING", checkLeaseExpiresAt: null, remediationDispatchKey: null, remediationDispatchVersion: null,
}; }
function current(search: SimulatorSupportSource, original = source(), trafficClass: "REAL" | "SYNTHETIC" = "REAL") {
  return isCurrentSimulatorSupportSource({ search, ref: { id: original.id, scheduleVersion: original.scheduleVersion, alertGeneration: original.alertGeneration, intentDigest: createSimulatorSupportIntentDigest(original) }, offeringId: "offering", trafficClass, timeZone: "UTC", now });
}

describe("offering-scoped simulator responder contract", () => {
  it("permits scheduler-only version advance but fences duration, offering, recipient and paused intent", () => {
    const original = source();
    expect(current({ ...original, scheduleVersion: 3 }, original)).toBe(true);
    for (const changed of [{ ...original, durationMinutes: 90 }, { ...original, status: "PAUSED" as const }, { ...original, additionalEmails: ["other@example.test"] }, { ...original, preferences: [{ courseId: "course", offeringId: "different", rank: 1 }] }]) expect(current(changed, original)).toBe(false);
  });
  it.each(["TEST", "AUTOMATION"] as const)("accepts only explicit current %s multi-cycle authority", trafficClass => {
    const synthetic = { ...source(), trafficClass, syntheticMultiCycle: true };
    expect(current(synthetic, synthetic, "SYNTHETIC")).toBe(true);
    expect(current({ ...synthetic, syntheticMultiCycle: false }, synthetic, "SYNTHETIC")).toBe(false);
    expect(current(synthetic, synthetic, "REAL")).toBe(false);
  });
  it("requires both production aliases and the exact Ready Git release", () => {
    const release = "b".repeat(40);
    const proof = { aliases: ["teetimespot.com", "www.teetimespot.com"], branch: "main", commitSha: release, deployedAt: "2026-10-06T14:00:00Z", deploymentId: "dpl_test", deploymentUrl: "https://test.vercel.app", source: "git" as const, state: "READY" as const };
    expect(() => assertSimulatorSupportDeployment(proof, release, now)).not.toThrow();
    expect(() => assertSimulatorSupportDeployment({ ...proof, aliases: ["teetimespot.com"] }, release, now)).toThrow();
    expect(() => assertSimulatorSupportDeployment(proof, "a".repeat(40), now)).toThrow();
  });
  it.each(["../src/test.ts", "C:/secret", ".env.production.local", ".vercel/project.json", "node_modules/test.ts"])("rejects unsafe implementation path %s", path => expect(() => validateSimulatorSupportPath(path)).toThrow());
  it("parses only exact assignment and owner fence options", () => {
    expect(readSimulatorSupportArguments(["claim", "--assignment-ref", "assigned"]).command).toBe("claim");
    expect(readSimulatorSupportArguments(["heartbeat", "--assignment-ref", "assigned", "--token", "token", "--revision", "2"]).revision).toBe(2);
    expect(() => readSimulatorSupportArguments(["heartbeat", "--assignment-ref", "assigned", "--token", "token", "--revision", "0"])).toThrow();
    expect(() => readSimulatorSupportArguments(["claim", "--assignment-ref", "assigned", "--sha", "a".repeat(40)])).toThrow();
    expect(readSimulatorSupportArguments(["configure", "--assignment-ref", "assigned", "--token", "token", "--revision", "2", "--manifest", "reviewed.json"]).apply).toBe(false);
    expect(readSimulatorSupportArguments(["configure", "--assignment-ref", "assigned", "--token", "token", "--revision", "2", "--manifest", "reviewed.json", "--apply"]).apply).toBe(true);
    expect(() => readSimulatorSupportArguments(["heartbeat", "--assignment-ref", "assigned", "--token", "token", "--revision", "2", "--apply"])).toThrow();
    expect(readSimulatorSupportArguments(["source-read", "--assignment-ref", "assigned", "--token", "token", "--revision", "2", "--source", "official"]).source).toBe("official");
    expect(() => readSimulatorSupportArguments(["source-read", "--assignment-ref", "assigned", "--token", "token", "--revision", "2", "--source", "http://localhost"])).toThrow();
    const fence = ["--assignment-ref", "assigned", "--token", "token", "--revision", "2"];
    expect(readSimulatorSupportArguments(["source-read", ...fence, "--link", "2", "--rendered"])).toMatchObject({ linkIndex: 2, rendered: true, source: undefined });
    expect(() => readSimulatorSupportArguments(["source-read", ...fence, "--link", "0"])).toThrow();
    expect(() => readSimulatorSupportArguments(["source-read", ...fence, "--link", "1", "--source", "official"])).toThrow();
    expect(() => readSimulatorSupportArguments(["progress", ...fence, "--rendered"])).toThrow();
    expect(readSimulatorSupportArguments(["progress", ...fence]).command).toBe("progress");
  });
  it("omits scripts, forms, credential links and local URLs from public research output", () => {
    expect(summarizeSimulatorSupportPublicHtml("<p>Hourly rentals</p><script>private state</script><form>password</form><a href='http://127.0.0.1'>Local</a><a href='/login?token=secret'>Login</a><a href='/rates'>Rates</a>", "https://venue.example.test"))
      .toEqual({ text: "Hourly rentals Local Login Rates", links: ["https://venue.example.test/rates"] });
  });
});
