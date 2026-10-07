// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { prepareSimulatorSupportReleaseProvenance } from "../../../scripts/automation/simulator-support";

const original = "a".repeat(40), upstream = "b".repeat(40), candidate = "c".repeat(40);

function gitFixture(head = candidate) {
  const run = vi.fn((args: string[]) => {
    const key = args.join(" ");
    if (key === "status --porcelain" || key === "fetch origin main" || key.startsWith("merge-base --is-ancestor")) return "";
    if (key === "rev-parse HEAD") return head;
    if (key === "rev-parse FETCH_HEAD") return upstream;
    if (key === "rev-parse origin/main") return upstream;
    if (key === `diff --name-only ${upstream} ${candidate}`) return "src/lib/simulators/providers/public-rental.ts\n";
    throw new Error(`Unexpected test command: ${key}`);
  });
  return run;
}

describe("simulator release CLI upstream provenance", () => {
  it("fetches current main and limits a code-bearing release to its trusted upstream delta", () => {
    const run = gitFixture();
    expect(prepareSimulatorSupportReleaseProvenance({ releaseSha: candidate, originalBaseSha: original,
      plannedPaths: ["src/lib/simulators/providers/public-rental.ts"] }, run)).toEqual({
      trustedUpstreamSha: upstream, upstreamDescendantVerified: true, descendantVerified: true,
      committedPaths: ["src/lib/simulators/providers/public-rental.ts"],
    });
    const calls = run.mock.calls.map(([args]) => args.join(" "));
    expect(calls.indexOf("fetch origin main")).toBeLessThan(calls.indexOf("rev-parse origin/main"));
    expect(calls.indexOf("fetch origin main")).toBeLessThan(calls.indexOf("rev-parse FETCH_HEAD"));
    expect(calls).toContain(`merge-base --is-ancestor ${original} ${upstream}`);
    expect(calls).toContain(`merge-base --is-ancestor ${upstream} ${candidate}`);
    expect(calls).toContain(`diff --name-only ${upstream} ${candidate}`);
    expect(calls).not.toContain(`diff --name-only ${original} ${candidate}`);
  });

  it("allows exact original-base metadata reuse while still verifying its relation to fresh main", () => {
    const run = gitFixture(original);
    expect(prepareSimulatorSupportReleaseProvenance({ releaseSha: original, originalBaseSha: original, plannedPaths: [] }, run)).toMatchObject({
      trustedUpstreamSha: upstream, committedPaths: [] });
    const calls = run.mock.calls.map(([args]) => args.join(" "));
    expect(calls).toContain(`merge-base --is-ancestor ${original} ${upstream}`);
    expect(calls).not.toContain(`merge-base --is-ancestor ${upstream} ${original}`);
    expect(calls.some(call => call.startsWith("diff --name-only"))).toBe(false);
  });

  it("allows exact trusted-upstream metadata reuse without claiming another worker's code", () => {
    const run = gitFixture(upstream);
    expect(prepareSimulatorSupportReleaseProvenance({ releaseSha: upstream, originalBaseSha: original, plannedPaths: [] }, run)).toMatchObject({
      trustedUpstreamSha: upstream, committedPaths: [] });
    const calls = run.mock.calls.map(([args]) => args.join(" "));
    expect(calls).toContain(`merge-base --is-ancestor ${original} ${upstream}`);
    expect(calls.some(call => call.startsWith("diff --name-only"))).toBe(false);
    expect(calls).not.toContain(`merge-base --is-ancestor ${upstream} ${upstream}`);
  });

  it("rejects a third unclaimed SHA for metadata-only reuse", () => {
    const run = gitFixture();
    expect(() => prepareSimulatorSupportReleaseProvenance({ releaseSha: candidate, originalBaseSha: original, plannedPaths: [] }, run)).toThrow("Metadata-only");
    expect(run.mock.calls.map(([args]) => args.join(" ")).some(call => call.startsWith("diff --name-only"))).toBe(false);
  });

  it("stops before fetch on a dirty or non-exact candidate and rejects either broken ancestry edge", () => {
    const dirty = gitFixture(); dirty.mockImplementationOnce(() => " M src/unowned.ts");
    expect(() => prepareSimulatorSupportReleaseProvenance({ releaseSha: candidate, originalBaseSha: original, plannedPaths: ["src/owned.ts"] }, dirty)).toThrow("clean exact");
    expect(dirty.mock.calls.map(([args]) => args.join(" "))).not.toContain("fetch origin main");
    for (const broken of [`merge-base --is-ancestor ${original} ${upstream}`, `merge-base --is-ancestor ${upstream} ${candidate}`]) {
      const run = gitFixture(); const normal = run.getMockImplementation()!;
      run.mockImplementation(args => { if (args.join(" ") === broken) throw new Error("ancestry rejected"); return normal(args); });
      expect(() => prepareSimulatorSupportReleaseProvenance({ releaseSha: candidate, originalBaseSha: original, plannedPaths: ["src/owned.ts"] }, run)).toThrow("ancestry rejected");
      expect(run.mock.calls.map(([args]) => args.join(" "))).not.toContain(`diff --name-only ${upstream} ${candidate}`);
    }
  });

  it("rejects a remote-tracking main ref that did not resolve to the just-fetched main", () => {
    const run = gitFixture(); const normal = run.getMockImplementation()!;
    run.mockImplementation(args => args.join(" ") === "rev-parse FETCH_HEAD" ? original : normal(args));
    expect(() => prepareSimulatorSupportReleaseProvenance({ releaseSha: candidate, originalBaseSha: original, plannedPaths: ["src/owned.ts"] }, run)).toThrow("trusted upstream");
    expect(run.mock.calls.map(([args]) => args.join(" "))).not.toContain(`diff --name-only ${upstream} ${candidate}`);
  });
});
