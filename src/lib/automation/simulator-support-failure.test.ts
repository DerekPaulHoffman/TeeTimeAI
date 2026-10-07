// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifySimulatorSupportFailure, readSafeSimulatorSupportFailure } from "./simulator-support-failure";
import { reportSimulatorSupportFailure } from "../../../scripts/automation/simulator-support";

const previousExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

describe("simulator support failure receipts", () => {
  it("classifies exact owned fences and keeps project-relative locations only", () => {
    const error = new Error("Simulator source changed during the public read.");
    error.stack = `Error: private-token at https://private.example.test/booking\n    at readSimulatorSupportSource (C:\\private\\TeeTimeAI\\src\\lib\\automation\\simulator-support-ownership.ts:149:10)\n    at another (C:\\private\\node_modules\\package\\index.js:3:1)`;
    expect(classifySimulatorSupportFailure(error)).toEqual({ stage: "POST_READ_OWNERSHIP", category: "SOURCE", code: "SOURCE_CHANGED_DURING_READ", sourceLocation: "src/lib/automation/simulator-support-ownership.ts:149" });
  });

  it("classifies allowlisted public transport, browser and database causes without copying their details", () => {
    const network = new Error("Get https://secret.example.test/path?token=private failed", { cause: Object.assign(new Error("hidden request"), { code: "ECONNRESET" }) });
    expect(classifySimulatorSupportFailure(network)).toMatchObject({ stage: "PUBLIC_READ", category: "NETWORK", code: "CONNECTION_RESET" });
    expect(classifySimulatorSupportFailure(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://private.example.test"))).toMatchObject({ stage: "PUBLIC_READ", category: "NETWORK", code: "BROWSER_DNS_FAILURE" });
    expect(classifySimulatorSupportFailure(Object.assign(new Error("private SQL statement"), { name: "PrismaClientKnownRequestError", code: "P2028" }))).toMatchObject({ stage: "COMMAND", category: "DATABASE", code: "DATABASE_TRANSACTION_FAILED" });
    expect(classifySimulatorSupportFailure(new Error("SIMULATOR_RESEARCH_BODY_LIMIT"), "PUBLIC_READ")).toMatchObject({ category: "BUDGET", code: "PUBLIC_BODY_LIMIT" });
    expect(classifySimulatorSupportFailure(new Error("SIMULATOR_RESEARCH_HARD_FAILED"))).toMatchObject({ stage: "PUBLIC_READ", category: "UNKNOWN", code: "PUBLIC_READ_HARD_FAILED" });
  });

  it("falls closed on unknown, decorated, cyclic or malicious errors", () => {
    const secret = "private-token-12345";
    const error = Object.assign(new Error(`Simulator support owner, revision or lease is stale. ${secret} https://private.example.test`), { code: secret });
    error.stack = `Error: ${secret}\n    at custom (https://private.example.test/src/lib/automation/private.ts:5:1)`;
    (error as Error & { cause?: unknown }).cause = error;
    const receipt = classifySimulatorSupportFailure(error);
    expect(receipt).toEqual({ stage: "COMMAND", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE" });
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(JSON.stringify(receipt)).not.toContain("private.example.test");
    for (const inherited of ["constructor", "toString", "__proto__"]) {
      expect(classifySimulatorSupportFailure(new Error(inherited))).toMatchObject({ category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE" });
      expect(classifySimulatorSupportFailure(Object.assign(new Error("unlisted"), { code: inherited }))).toMatchObject({ category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE" });
    }
  });

  it("keeps a CLI hard failure nonzero while emitting only a sanitized receipt and generic stop instruction", () => {
    const secret = "private-user@example.test";
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
    const failure = reportSimulatorSupportFailure(new Error(`Unexpected private URL https://example.test/?recipient=${secret}`));
    expect(failure).toMatchObject({ stage: "COMMAND", category: "UNKNOWN", code: "UNCLASSIFIED_FAILURE" });
    expect(process.exitCode).toBe(1);
    const output = write.mock.calls.map(call => String(call[0])).join("");
    expect(output).toContain('"simulatorSupportFailure"');
    expect(output).toContain("preserve offering ownership and stop this operation");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("https://example.test");
  });

  it("reports only a validated settled failure and fresh owned revision after a hard read checkpoint", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
    const settled = classifySimulatorSupportFailure(new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://private.example.test"), "PUBLIC_READ");
    reportSimulatorSupportFailure(new Error("SIMULATOR_RESEARCH_HARD_FAILED"), "COMMAND", 8, settled);
    const receipt = JSON.parse(String(write.mock.calls[0][0])) as { simulatorSupportFailure: Record<string, unknown> };
    expect(receipt.simulatorSupportFailure).toEqual({ ...settled, latestOwnedRevision: 8 });
    expect(process.exitCode).toBe(1);
    expect(readSafeSimulatorSupportFailure({ ...settled, sourceLocation: "src/lib/automation/secret.ts:3?token=hidden" })).toBeNull();
    expect(readSafeSimulatorSupportFailure({ ...settled, sourceLocation: "src/lib/automation/simulator-support-private-user.ts:3" })).toBeNull();
    expect(readSafeSimulatorSupportFailure({ ...settled, code: "private@example.test" })).toBeNull();
    expect(readSafeSimulatorSupportFailure({ ...settled, category: "DATABASE" })).toBeNull();
    expect(readSafeSimulatorSupportFailure({ stage: "PUBLIC_READ", category: "UNKNOWN", code: "RESEARCH_RESERVATION_INTERRUPTED" })).toEqual({
      stage: "PUBLIC_READ", category: "UNKNOWN", code: "RESEARCH_RESERVATION_INTERRUPTED" });
  });
});
