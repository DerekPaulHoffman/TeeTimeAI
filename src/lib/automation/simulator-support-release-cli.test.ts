// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { assertSimulatorSupportCompletionCheckout, prepareSimulatorSupportReleaseProvenance, readSimulatorSupportArguments, requestSimulatorEngineeringVerification } from "../../../scripts/automation/simulator-support";

const original = "a".repeat(40), upstream = "b".repeat(40), candidate = "c".repeat(40);

describe("private simulator source CLI selection", () => {
  const ownerArgs = ["--assignment-ref", "owned-assignment", "--token", "owned-token", "--revision", "3"];
  it("permits engineering verification only with the original authority and no arbitrary provider/date input", async () => {
    expect(readSimulatorSupportArguments(["verify-engineering", ...ownerArgs])).toMatchObject({ command: "verify-engineering", revision: 3 });
    for (const extra of [["--source", "booking"], ["--url", "https://public.example"], ["--date", "2026-10-09"], ["--sha", "a".repeat(40)]]) {
      expect(() => readSimulatorSupportArguments(["verify-engineering", ...ownerArgs, ...extra])).toThrow();
    }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ engineeringOnly: true, customerAcceptance: false, revision: 5 }), { status: 200 }));
    await requestSimulatorEngineeringVerification({ assignmentRef: "owned-assignment", token: "owned-token", revision: 3 }, { apiKey: "private_test_key", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith("https://teetimespot.com/api/automation/simulator-support/verify", expect.objectContaining({ redirect: "error", method: "POST",
      body: JSON.stringify({ assignmentRef: "owned-assignment", token: "owned-token", revision: 3 }) }));
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ customerAcceptance: true }), { status: 200 }));
    await expect(requestSimulatorEngineeringVerification({ assignmentRef: "owned-assignment", token: "owned-token", revision: 3 }, { apiKey: "private_test_key", fetchImpl })).rejects.toThrow("invalid independent result");
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ code: "READ_IN_FLIGHT", error: "private body" }), { status: 409 }));
    await expect(requestSimulatorEngineeringVerification({ assignmentRef: "owned-assignment", token: "owned-token", revision: 3 }, { apiKey: "private_test_key", fetchImpl })).rejects.toMatchObject({ code: "READ_IN_FLIGHT", httpStatus: 409 });
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ code: "private_body_with_token", error: "private body" }), { status: 503 }));
    await expect(requestSimulatorEngineeringVerification({ assignmentRef: "owned-assignment", token: "owned-token", revision: 3 }, { apiKey: "private_test_key", fetchImpl })).rejects.toMatchObject({ code: "VERIFICATION_FAILED", httpStatus: 503 });
  });
  it("requires an explicit applied reviewed configuration for metadata repair", () => {
    expect(readSimulatorSupportArguments(["configure", ...ownerArgs, "--manifest", "C:/private/manifest.json",
      "--repair", "--apply"])).toMatchObject({ command: "configure", repair: true, apply: true });
    expect(() => readSimulatorSupportArguments(["configure", ...ownerArgs, "--manifest", "C:/private/manifest.json",
      "--repair"])).toThrow();
    expect(() => readSimulatorSupportArguments(["classify", ...ownerArgs, "--manifest", "C:/private/manifest.json",
      "--repair", "--apply"])).toThrow();
  });
  it("accepts the derived-root selector with only the original owned read options", () => {
    expect(readSimulatorSupportArguments(["source-read", ...ownerArgs, "--source", "booking-root"])).toMatchObject({
      command: "source-read", assignmentRef: "owned-assignment", token: "owned-token", revision: 3, source: "booking-root", rendered: false, linkIndex: undefined });
    expect(readSimulatorSupportArguments(["source-read", ...ownerArgs, "--source", "booking-root", "--rendered"]).rendered).toBe(true);
  });
  it("rejects caller URLs, other roots, combined link selection and use on another command", () => {
    for (const args of [
      ["source-read", ...ownerArgs, "--source", "booking-root", "--url", "https://yourgolfbooking.com/venues/other/booking"],
      ["source-read", ...ownerArgs, "--source", "https://yourgolfbooking.com/venues/other/booking"],
      ["source-read", ...ownerArgs, "--source", "booking-parent"],
      ["source-read", ...ownerArgs, "--source", "booking-root", "--link", "1"],
      ["inspect", ...ownerArgs, "--source", "booking-root"],
    ]) expect(() => readSimulatorSupportArguments(args)).toThrow();
  });
});

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
  it("does not complete an older release while the original worker has an unfinished repair", () => {
    const clean = gitFixture(candidate);
    expect(() => assertSimulatorSupportCompletionCheckout(candidate, clean)).not.toThrow();
    const dirty = gitFixture(candidate); dirty.mockImplementationOnce(() => " M src/lib/simulators/providers/public-rental.ts");
    expect(() => assertSimulatorSupportCompletionCheckout(candidate, dirty)).toThrow("clean exact owned release");
    const advanced = gitFixture(upstream);
    expect(() => assertSimulatorSupportCompletionCheckout(candidate, advanced)).toThrow("clean exact owned release");
  });
  it("requires the prior registered release to be an ancestor of the new owned candidate", () => {
    const prior = "d".repeat(40);
    const run = gitFixture();
    const proof = prepareSimulatorSupportReleaseProvenance({ releaseSha: candidate, originalBaseSha: original,
      priorReleaseSha: prior, plannedPaths: ["src/lib/simulators/providers/public-rental.ts"] }, run);
    expect(proof).toMatchObject({ priorReleaseDescendantVerified: true,
      committedPaths: ["src/lib/simulators/providers/public-rental.ts"] });
    expect(run.mock.calls.map(([args]) => args.join(" "))).toContain(`merge-base --is-ancestor ${prior} ${candidate}`);
    const reject = gitFixture(); reject.mockImplementation(args => {
      if (args.join(" ") === `merge-base --is-ancestor ${prior} ${candidate}`) throw new Error("not ancestor");
      return run.getMockImplementation()!(args);
    });
    expect(() => prepareSimulatorSupportReleaseProvenance({ releaseSha: candidate, originalBaseSha: original,
      priorReleaseSha: prior, plannedPaths: ["src/lib/simulators/providers/public-rental.ts"] }, reject)).toThrow("not ancestor");
  });
  it("permits a metadata-only refresh to current trusted upstream containing the prior owned release", () => {
    const proof = prepareSimulatorSupportReleaseProvenance({ releaseSha: upstream, originalBaseSha: original,
      priorReleaseSha: candidate, plannedPaths: ["src/lib/simulators/providers/public-rental.ts"] }, gitFixture(upstream));
    expect(proof).toMatchObject({ trustedUpstreamSha: upstream, priorReleaseDescendantVerified: true, committedPaths: [] });
  });
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
