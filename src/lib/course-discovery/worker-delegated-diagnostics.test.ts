// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createDiscoveryProcess, safeBrowserFailureDiagnostics, safeTeeItUpDelegationDiagnostic } from "../../../scripts/automation/course-discovery-worker.mjs";
import { createDelegationDiagnostic, delegatedDiagnosticGates, delegatedDiagnosticStages } from "./teeitup-delegated-booking-diagnostic";

describe("closed delegated failure bridge", () => {
  it.each(delegatedDiagnosticStages)("mirrors the actual native stage and every current nullable gate: %s", stage => {
    const value = createDelegationDiagnostic(stage);
    value.gates.rootFresh = true; value.gates.hopStatus200 = false; value.gates.rootDocumentProvenance = true;
    value.gates.physicalRaw = true; value.gates.physicalRendered = false; value.gates.physicalNameRelation = null; value.gates.physicalPhone = true;
    const copied = safeBrowserFailureDiagnostics({ teeItUpDelegation: { ...value, url: "PRIVATE", gates: { ...value.gates, cookie: "PRIVATE" } } }).teeItUpDelegation;
    expect(copied).toEqual(value); expect(Object.keys(copied.gates)).toEqual([...delegatedDiagnosticGates]);
    value.gates.rootFresh = false; expect(copied.gates.rootFresh).toBe(true);
    expect(JSON.stringify(copied)).not.toContain("PRIVATE");
  });
  it.each(["stage", "missing", "text", "number", "array", "throw"])("omits malformed diagnostic without authority or private fields: %s", mode => {
    const value: Record<string, unknown> = createDelegationDiagnostic("ROOT_LINK");
    const gates = value.gates as Record<string, unknown>;
    if (mode === "stage") value.stage = "PRIVATE";
    if (mode === "missing") delete gates.rootFresh;
    if (mode === "text") gates.rootFresh = "PRIVATE";
    if (mode === "number") gates.rootFresh = 1;
    if (mode === "array") value.gates = [];
    if (mode === "throw") Object.defineProperty(gates, "rootFresh", { get() { throw Error("PRIVATE"); } });
    expect(safeTeeItUpDelegationDiagnostic(value)).toBeUndefined();
  });
  it("carries the exact primary and native group through the actual helper response decoder", async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: 0 });
    const channel = createDiscoveryProcess({ executable: "unused", args: [], cwd: "unused", environment: {}, spawnProcess: () => child });
    const value = createDelegationDiagnostic("NATIVE_DOCUMENT_READ"); value.gates.hopNoFatal = false;
    const pending = channel.request({ action: "inspect_adapter" });
    child.stdout.write(JSON.stringify({ id: 1, ok: false, error: "OFFICIAL_DELEGATED_SOURCE_UNVERIFIED", diagnostics: {
      teeItUpDelegation: { ...value, html: "PRIVATE", gates: { ...value.gates, token: "PRIVATE" } },
    } }) + "\n");
    await expect(pending).rejects.toMatchObject({ code: "OFFICIAL_DELEGATED_SOURCE_UNVERIFIED", details: { browserDiagnostics: { teeItUpDelegation: value } } });
    await channel.close(); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
  });
});
