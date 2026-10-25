// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runCourseDiscoveryStagehandWorker, prepareCourseDiscoveryStagehandWorker } from "../../../scripts/automation/course-discovery-stagehand-worker.mjs";
import { createStagehandSourceCheckpoint, readStagehandSourceCheckpoint, stagehandDataHash, publicStagehandSourceUrl,
  } from "../../../scripts/automation/course-discovery-stagehand-source.mjs";
import { observedInspectionPath } from "../../../scripts/automation/course-discovery-stagehand-inspection.mjs";
import { accessRecipeSchema } from "./recipe";
import { createStagehandGuardedBrowserHost } from "../../../scripts/automation/course-discovery-stagehand-host.mjs";
import { sourceDiscover as actualSourceDiscover } from "../../../scripts/automation/stagehand/source-discovery.mjs";

const first = Date.parse("2030-01-02T12:00:00.000Z");
const official = "https://unseen-course.example/";
const booking = "https://unseen-public-booking.example/public?view=public";
function fixture() {
  const job = { id: "owned-unseen-job", leaseToken: "private-new-owned-lease-token", sourceFingerprint: "a".repeat(64), attempts: 1,
    firstPickedUpAt: new Date(first).toISOString(), deadlineAt: new Date(first + 900_000).toISOString(), checkpoint: undefined as unknown,
    request: { target: { courseId: "unseen-course", kind: "OUTDOOR" }, demand: { searchId: "owned-search", alertGeneration: 1 },
      identity: { name: "Unseen Public Course", officialUrl: official, bookingUrl: "https://old-known.example/", providerFamily: "PRIVATE_HINT",
        timeZone: "UTC", address: "10 Public Road, Test City, CA 90001" },
      input: { date: "2030-01-03", timeZone: "UTC", players: 2, startTime: "08:00", endTime: "18:00" },
      trustedContext: { canonicalCoursePhone: "+15555550123" } } };
  const report = { framework: { name: "Stagehand", version: "4.3.0" }, jobId: job.id, firstPickedUpAt: job.firstPickedUpAt,
    deadlineAt: job.deadlineAt, workDeadlineAt: new Date(first + 120_000).toISOString(), startedAt: new Date(first + 100).toISOString(),
    finishedAt: new Date(first + 1500).toISOString(), frameworkMode: "HYBRID_SOURCE_DISCOVERY", frameworkRole: "SOURCE_DISCOVERY_ONLY",
    frameworkExtractedTimes: false, outcome: "SOURCE_PROPOSED_UNVERIFIED", browserClosed: true, modelClosed: true, recipe: null, matchingSlots: [],
    adapterSourceProposal: { schemaVersion: 1, kind: "EXISTING_ADAPTER_SOURCE", bookingUrl: booking },
    visitedUrls: [official, booking], officialLinkLedger: [{ pageUrl: official, links: [{ href: booking }] }], frameLedger: [],
    actions: [{ sourceUrl: official, action: { method: "click" }, observedTarget: { tag: "A", href: booking }, afterUrl: booking }],
    initialNavigation: { requestedUrl: official, finalUrl: official, status: 200 },
    metrics: { model: "gpt-6.1-sol", reasoningEffort: "medium", localCodexCalls: [
      { model: "gpt-6.1-sol", usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2 } },
      { model: "gpt-6.1-sol", usage: { totalTokens: 8, inputTokens: 6, outputTokens: 2 } },
    ] } };
  return { job, report, clock: first + 2000 };
}
function setup() {
  const f = fixture(), events: string[] = [], checkpoints: unknown[] = [], sourceCalls: unknown[] = [];
  const adapter = { family: "FOREUP", facilityId: 12, scheduleId: 34, bookingClassId: 56 };
  const environment = () => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME", COURSE_DISCOVERY_JOB_ID: f.job.id,
    COURSE_DISCOVERY_JOB_KIND: "discovery", COURSE_DISCOVERY_LEASE_TOKEN: f.job.leaseToken, LOCAL_READER_DEVICE_TOKEN: "PRIVATE_BACKEND_TOKEN" });
  const request = vi.fn(async (action: { action: string; url?: string }) => {
    events.push(action.action);
    return { url: official, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false,
      loading: false, controls: [{ kind: "link", href: booking }], adapter: action.action === "inspect_adapter" ? adapter : undefined };
  });
  const close = vi.fn(async () => { events.push("closed"); });
  const browserFactory = vi.fn(async () => ({ request, close }));
  const sourceDiscover = vi.fn(async (args: unknown) => { sourceCalls.push(args); events.push("source"); return f.report; });
  const client = {
    helperEnvironment: vi.fn(environment), checkpoint: vi.fn(async (_id, _token, value) => { checkpoints.push(structuredClone(value)); return {}; }),
    candidate: vi.fn(async (_id, _token, _recipe, _signal, _evidence) => {
      expect(_id).toBe(f.job.id); expect(_token).toBe(f.job.leaseToken); expect(_recipe).toBeTruthy(); void _signal; expect(_evidence).toBeTruthy();
      events.push("candidate"); expect(close).toHaveBeenCalled(); return { recipeHash: "b".repeat(64), challenges: [
        { id: "backend-one", recipeHash: "b".repeat(64), input: f.job.request.input },
        { id: "backend-two", recipeHash: "b".repeat(64), input: { ...f.job.request.input, date: "2030-01-04", players: 3 } },
      ] };
    }),
    verification: vi.fn(async () => { events.push("verification"); return {}; }),
    activate: vi.fn(async () => { events.push("activate"); return { activated: true }; }),
  };
  const validateRecipe = vi.fn(async ({ recipe }) => ({ valid: accessRecipeSchema.safeParse(recipe).success }));
  const executeRecipe = vi.fn(async () => {
    events.push("execute"); return { status: "AVAILABLE", complete: true, slots: [], evidence: {
      venueVerified: true, dateVerified: true, capacityVerified: true, durationVerified: true, completeVerified: true } };
  });
  const beforeActivate = vi.fn(async () => { events.push("before"); }), afterActivate = vi.fn(async () => { events.push("after"); });
  const run = (extra = {}) => runCourseDiscoveryStagehandWorker({ job: f.job, workDeadlineAt: new Date(first + 720_000).toISOString(),
    client, cwd: process.cwd(), now: () => f.clock, sourceDiscover, browserFactory, validateRecipe, executeRecipe, beforeActivate, afterActivate, ...extra });
  return { f, events, checkpoints, sourceCalls, request, close, browserFactory, sourceDiscover, client, validateRecipe, executeRecipe, beforeActivate, afterActivate, run };
}

describe("regular Stagehand source worker", () => {
  it.each(["STAGEHAND_SOURCE_ACTION_UNAVAILABLE", "STAGEHAND_SOURCE_ACTION_REJECTED", "STAGEHAND_SOURCE_LOADING_INCOMPLETE"])("preserves emitted own unresolved diagnostic %s without admitting source or recipe authority", async code => {
    const t = setup(); Object.assign(t.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: code });
    await expect(t.run()).rejects.toThrow(code);
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
    expect(t.executeRecipe).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
    const foreign = setup(); Object.assign(foreign.f.report, { jobId: "foreign-job", outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: code });
    await expect(foreign.run()).rejects.toThrow("STAGEHAND_SOURCE_REPORT_INVALID");
    expect(foreign.browserFactory).not.toHaveBeenCalled(); expect(foreign.client.candidate).not.toHaveBeenCalled();
  });

  it("preserves a closed startup cause through actual worker→source SDK→private host failure without any model constructor", async () => {
    for (const code of ["STAGEHAND_NATIVE_HOST_DEADLINE", "STAGEHAND_NATIVE_HOST_FAILED", "OWNED_STAGEHAND_CDP_UNAVAILABLE", "PRIVATE_UNKNOWN_TOKEN"]) {
      const t = setup(), current = Date.now();
      t.f.clock = current; t.f.job.firstPickedUpAt = new Date(current + 2000).toISOString(); t.f.job.deadlineAt = new Date(current + 902000).toISOString();
      const processFactory = vi.fn(() => { throw Error(code); });
      await expect(t.run({ sourceDiscover: actualSourceDiscover, guardedBrowserFactory: args => createStagehandGuardedBrowserHost({ ...args, processFactory }) }))
        .rejects.toThrow(code === "PRIVATE_UNKNOWN_TOKEN" ? "STAGEHAND_SOURCE_DISCOVERY_FAILED" : code);
      expect(processFactory).toHaveBeenCalledOnce(); expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
    }
  });
  it.each([-5000, 0, 2000, 5000])("clamps a valid %sms database-clock offset through the actual private host wrapper before spawn", async offset => {
    const t = setup(); t.f.clock = first - offset;
    const clock = vi.spyOn(Date, "now").mockReturnValue(t.f.clock);
    const request = vi.fn(async value => value.action === "start" ? { kind: "OWNED_GUARDED_STAGEHAND_CONTEXT",
      cdpUrl: "ws://127.0.0.1:51515/devtools/browser/" + "a".repeat(32), targetId: "owned-only" } : { browserClosed: true, providerRequestsDrained: true });
    const close = vi.fn(async () => {}), processFactory = vi.fn(() => ({ request, close }));
    let supplied;
    try {
      await expect(t.run({ sourceDiscover: async args => {
        supplied = args; const host = await args.createGuardedBrowser({ deadlineAt: args.deadlineAt, signal: args.signal });
        await host.close();
        return { ...t.f.report, outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: "STAGEHAND_NATIVE_HOST_DEADLINE" };
      }, guardedBrowserFactory: args => createStagehandGuardedBrowserHost({ ...args, processFactory }) })).rejects.toThrow("STAGEHAND_NATIVE_HOST_DEADLINE");
      expect(Date.parse(supplied.deadlineAt)).toBe(Math.min(first + 120_000, t.f.clock + 120_000));
      expect(supplied.job.firstPickedUpAt).toBe(t.f.job.firstPickedUpAt);
      expect(supplied.job.deadlineAt).toBe(t.f.job.deadlineAt);
      expect(processFactory).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
      expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("rejects a database first pickup beyond the unchanged 5s allowance before source or host", async () => {
    const t = setup(); t.f.clock = first - 5001;
    await expect(t.run()).rejects.toThrow("DISCOVERY_JOB_INVALID"); expect(t.sourceDiscover).not.toHaveBeenCalled();
  });

  it("reproduces the old future-database-clock host guard without spawning, and never widens that guard", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(first - 2000), processFactory = vi.fn();
    try {
      await expect(createStagehandGuardedBrowserHost({ cwd: process.cwd(), initialUrl: official, timeZone: "UTC",
        deadlineAt: new Date(first + 120_000).toISOString(), helperEnvironment: { COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME",
          COURSE_DISCOVERY_JOB_KIND: "discovery", COURSE_DISCOVERY_JOB_ID: "owned", COURSE_DISCOVERY_LEASE_TOKEN: "private" }, processFactory })).rejects.toThrow("STAGEHAND_NATIVE_HOST_DEADLINE");
      expect(processFactory).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("never forwards an unknown private failure string or another job's failure as an own primary cause", async () => {
    for (const change of ["unknown", "job", "recipe", "times"]) {
      const t = setup(); Object.assign(t.f.report, { outcome: "UNRESOLVED", adapterSourceProposal: null, frameworkFailureCode: "STAGEHAND_NATIVE_HOST_DEADLINE" });
      if (change === "unknown") t.f.report.frameworkFailureCode = "PRIVATE_TOKEN_ABC123";
      if (change === "job") t.f.report.jobId = "other-job";
      if (change === "recipe") t.f.report.recipe = { private: true };
      if (change === "times") t.f.report.matchingSlots = [{ time: "10:00" }];
      await expect(t.run()).rejects.toThrow("STAGEHAND_SOURCE_REPORT_INVALID"); expect(t.client.candidate).not.toHaveBeenCalled();
    }
  });
  it("routes once, freshly inspects, validates real schema, closes, then independently verifies both backend challenges and activates", async () => {
    const t = setup(), result = await t.run();
    expect(result.outcome).toBe("activated"); expect(result.metrics).toMatchObject({ model: "gpt-6.1-sol", modelCalls: 2,
      tokenUsage: { totalTokens: 20, inputTokens: 16, outputTokens: 4 }, fixedInspectionModelCalls: 0, replayModelCalls: 0, sourceResumed: false });
    expect(t.sourceDiscover).toHaveBeenCalledOnce(); expect(t.executeRecipe).toHaveBeenCalledTimes(2);
    expect(t.executeRecipe.mock.calls.map(([args]) => args.input)).toEqual([t.f.job.request.input, { ...t.f.job.request.input, date: "2030-01-04", players: 3 }]);
    expect(t.executeRecipe.mock.calls.every(([args]) => args.deadlineAt === t.f.job.deadlineAt)).toBe(true);
    expect(t.client.verification).toHaveBeenCalledTimes(2); expect(t.client.activate).toHaveBeenCalledOnce();
    expect(t.events.indexOf("closed")).toBeLessThan(t.events.indexOf("candidate"));
    expect(t.events.slice(-3)).toEqual(["before", "activate", "after"]);
    expect(t.afterActivate).toHaveBeenCalledWith({ metrics: result.metrics });
    expect(t.client.candidate.mock.calls[0][4]).toEqual({ officialUrl: official, observedBookingUrl: booking });
    expect(t.client.candidate.mock.calls[0][2]).toMatchObject({ target: t.f.job.request.target, source: { venueName: t.f.job.request.identity.name, providerFamily: "FOREUP" } });
  });

  it("passes only ordinary canonical public identity/target/input to the source SDK; never hints, demand, authority or trusted phone", async () => {
    const t = setup(); await t.run(); const args = t.sourceCalls[0] as { job: { request: object }; deadlineAt: string };
    expect(Object.keys(args.job).sort()).toEqual(["deadlineAt", "firstPickedUpAt", "id", "request"]);
    expect(Object.keys(args.job.request).sort()).toEqual(["identity", "input", "target"]);
    expect(JSON.stringify(args)).not.toMatch(/PRIVATE_HINT|old-known|leaseToken|private-new|canonicalCoursePhone|15555550123|PRIVATE_BACKEND_TOKEN|owned-search/);
    expect(args.deadlineAt).toBe(new Date(first + 120_000).toISOString());
    expect(t.browserFactory.mock.calls[0][0]).toMatchObject({ requestedInput: t.f.job.request.input, trustedContext: t.f.job.request.trustedContext });
  });

  it("uses same-job source checkpoint on attempt2 beyond120s, but runs a new native inspector and zero new models", async () => {
    const t = setup(); t.f.job.attempts = 2;
    t.f.job["checkpoint"] = { stagehandSource: createStagehandSourceCheckpoint({ ...t.f.job, attempts: 1 }, t.f.report) };
    t.f.clock = first + 140_000;
    const result = await t.run();
    expect(t.sourceDiscover).not.toHaveBeenCalled(); expect(t.browserFactory).toHaveBeenCalledOnce();
    expect(result.metrics).toMatchObject({ sourceResumed: true, modelCalls: 0, sourceElapsedMs: 0, tokenUsage: {} });
    expect(t.client.verification).toHaveBeenCalledTimes(2); expect(t.client.activate).toHaveBeenCalledOnce();
  });

  it.each(["job", "fingerprint", "request", "clock", "report", "proof", "attempt"])("rejects a changed %s source checkpoint before source, browser or candidate", async change => {
    const t = setup(); t.f.job.attempts = 2;
    const ref = createStagehandSourceCheckpoint({ ...t.f.job, attempts: 1 }, t.f.report);
    t.f.job["checkpoint"] = { stagehandSource: ref }; t.f.clock = first + 140_000;
    if (change === "job") ref.jobId = "other-job";
    if (change === "fingerprint") ref.sourceFingerprint = "f".repeat(64);
    if (change === "request") t.f.job.request.input.players = 3;
    if (change === "clock") ref.deadlineAt = new Date(first + 900_001).toISOString();
    if (change === "report") ref.report.visitedUrls.push("https://invented.example/");
    if (change === "proof") { ref.report["adapter"] = { family: "FOREUP", proof: true }; ref.reportSha256 = stagehandDataHash(ref.report); }
    if (change === "attempt") ref.attempt = 2;
    await expect(t.run()).rejects.toThrow(); expect(t.sourceDiscover).not.toHaveBeenCalled();
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it("missing checkpoint after source120s never starts another model run or resets original deadline", async () => {
    const t = setup(); t.f.job.attempts = 2; t.f.clock = first + 121_000;
    await expect(t.run()).rejects.toMatchObject({ code: "STAGEHAND_SOURCE_BUDGET_EXHAUSTED" });
    expect(t.sourceDiscover).not.toHaveBeenCalled(); expect(t.browserFactory).not.toHaveBeenCalled();
  });

  it("retains returned completed-call lower bounds when source completes at the deadline without a metrics callback", async () => {
    const t = setup(); t.sourceDiscover.mockImplementation(async () => { t.f.clock = first + 120_000; return t.f.report; });
    await expect(t.run()).rejects.toMatchObject({ code: "STAGEHAND_SOURCE_BUDGET_EXHAUSTED", discoveryMetrics: {
      modelCalls: 2, tokenUsage: { totalTokens: 20, inputTokens: 16, outputTokens: 4 }, sourceUsageRecordedLowerBound: true } });
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it.each(["recipe", "times", "mode", "model", "effort", "job", "clock", "browser", "modelCleanup", "proposal", "unresolved"])("rejects %s source authority/report mismatch before fixed inspection", async change => {
    const t = setup(), r = t.f.report;
    if (change === "recipe") r.recipe = { engine: "BROWSER_DOM" };
    if (change === "times") r.matchingSlots.push({ startsAt: "2030-01-03T10:00:00Z" });
    if (change === "mode") r.frameworkMode = "NATIVE_FRAMEWORK";
    if (change === "model") r.metrics.model = "forbidden";
    if (change === "effort") r.metrics.reasoningEffort = "low";
    if (change === "job") r.jobId = "other-job";
    if (change === "clock") r.deadlineAt = new Date(first + 900_001).toISOString();
    if (change === "browser") r.browserClosed = false;
    if (change === "modelCleanup") r.modelClosed = false;
    if (change === "proposal") r.adapterSourceProposal["metadata"] = { family: "FOREUP" };
    if (change === "unresolved") r.outcome = "UNRESOLVED";
    await expect(t.run()).rejects.toThrow(); expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it("source checkpoint contains exact actual provenance but no prose, hidden phone, model adapter or executable data", () => {
    const f = fixture(); f.report["evidenceSummary"] = "PRIVATE_MODEL_PROSE"; f.report["adapter"] = { proof: "PRIVATE_PROOF" };
    const value = createStagehandSourceCheckpoint(f.job, f.report), text = JSON.stringify(value);
    expect(text).not.toMatch(/PRIVATE_MODEL|PRIVATE_PROOF|canonicalCoursePhone|15555550123|leaseToken|private-new/);
    expect(value.report.officialLinkLedger).toEqual(f.report.officialLinkLedger);
    expect(value.report.actions[0].observedTarget.href).toBe(booking);
    expect(observedInspectionPath(value.report, official, booking)).toEqual([official, booking]);
    expect(readStagehandSourceCheckpoint({ ...f.job, attempts: 2, checkpoint: { stagehandSource: value } }, undefined, first + 140_000)?.report)
      .toEqual(value.report);
  });

  it("oversized full provenance fails honestly rather than truncating selected source/path", async () => {
    const t = setup(); t.f.report.officialLinkLedger[0].links.push(...Array.from({ length: 100 }, (_, n) => ({ href: "https://extra.example/" + n + "x".repeat(400) })));
    await expect(t.run()).rejects.toMatchObject({ code: "STAGEHAND_SOURCE_CHECKPOINT_LIMIT" });
    expect(t.browserFactory).not.toHaveBeenCalled(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it.each(["missing", "query", "unclicked"])("does not grant source authority to an %s observed edge", async change => {
    const t = setup();
    if (change === "missing") t.f.report.officialLinkLedger = [];
    if (change === "query") t.f.report.adapterSourceProposal.bookingUrl += "&invented=1";
    if (change === "unclicked") t.f.report.actions = [];
    await expect(t.run()).rejects.toThrow(); expect(t.browserFactory).not.toHaveBeenCalled();
  });

  it("requires the exact fresh native link, not a cached source-ledger claim", async () => {
    const t = setup(); t.request.mockImplementation(async () => ({ url: official, browserTransport: "NATIVE_CHROME", navigationStatus: 200, loading: false,
      accessRequirementObserved: false, controls: [], adapter: undefined }));
    await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_PATH_STALE" });
    expect(t.close).toHaveBeenCalledOnce(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it("a currently visible observed iframe is routing evidence, but still requires fresh native frame admission and typed inspection", async () => {
    const t = setup(); t.f.report.actions = []; t.f.report.visitedUrls = [official];
    t.f.report.officialLinkLedger = []; t.f.report.frameLedger = [{ pageUrl: official, frames: [{ src: booking, visible: true }] }];
    t.request.mockImplementation(async action => ({ url: official, browserTransport: "NATIVE_CHROME", navigationStatus: 200, loading: false,
      accessRequirementObserved: false, controls: [], frames: [{ source: "OFFICIAL_IFRAME_SRC", url: booking }],
      adapter: action.action === "inspect_adapter" ? { family: "FOREUP", facilityId: 12, scheduleId: 34, bookingClassId: 56 } : undefined }));
    await t.run(); expect(t.client.activate).toHaveBeenCalledOnce(); expect(t.sourceDiscover).toHaveBeenCalledOnce();
  });

  it("opens an exact fresh officially linked CPS context before its first inspector without relabelling the official parent", async () => {
    const t = setup(), source = "https://new-public-course.cps.golf/onlineresweb/search-teetime?TeeOffTimeMin=0&TeeOffTimeMax=23.999722222222225";
    t.f.report.adapterSourceProposal.bookingUrl = source; t.f.report.visitedUrls = [official, source];
    t.f.report.officialLinkLedger[0].links = [{ href: source }];
    t.f.report.actions[0].observedTarget.href = source; t.f.report.actions[0].afterUrl = source;
    let current = official;
    t.request.mockImplementation(async action => {
      if (action.action === "open") current = action.url ?? current;
      return { url: current, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false, loading: false,
        controls: current === official ? [{ kind: "link", href: source }] : [],
        adapter: action.action === "inspect_adapter" ? { family: "CPS", tenant: "new-public-course", courseIds: [91], catalogHash: "c".repeat(64) } : undefined };
    });
    await t.run();
    expect(t.request.mock.calls.map(([value]) => value)).toEqual([{ action: "open", url: official }, { action: "open", url: source }, { action: "inspect_adapter", url: source }]);
    expect(t.client.candidate.mock.calls[0][2].source.bookingUrl).toBe(source);
  });

  it.each([true, false])("fresh official alias transition requires its exact native attestation (present=%s)", async present => {
    const t = setup(), alias = "https://fresh-official-alias.example/";
    t.request.mockImplementation(async action => ({ url: alias, browserTransport: "NATIVE_CHROME", navigationStatus: 200, loading: false,
      accessRequirementObserved: false, controls: [{ kind: "link", href: booking }],
      ...(present ? { nativeDocumentRedirects: [{ fromUrl: official, toUrl: alias, status: 301, completed: true }] } : {}),
      adapter: action.action === "inspect_adapter" ? { family: "FOREUP", facilityId: 12, scheduleId: 34, bookingClassId: 56 } : undefined }));
    if (present) { await t.run(); expect(t.client.activate).toHaveBeenCalledOnce(); }
    else { await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_LANDING_CHANGED" }); expect(t.client.candidate).not.toHaveBeenCalled(); }
  });

  it("a failed metadata schema never reaches the candidate API, even with a valid observed source", async () => {
    const t = setup(); t.validateRecipe.mockResolvedValue({ valid: false });
    await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_METADATA_INVALID" });
    expect(t.close).toHaveBeenCalledOnce(); expect(t.client.candidate).not.toHaveBeenCalled();
  });

  it("never downgrades native-only helper transport, even when source used a signed-out public browser", async () => {
    const t = setup(); t.client.helperEnvironment.mockImplementation(() => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "PINNED_HTTP" }));
    await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_SCOPE_INVALID" });
    expect(t.browserFactory).not.toHaveBeenCalled();
  });

  it("preserves the primary fixed-reader failure when cleanup also fails; no method is submitted", async () => {
    const t = setup(), primary = Object.assign(Error("private body"), { code: "MINDBODY_PUBLIC_FILTER_UNSETTLED" });
    t.request.mockRejectedValue(primary); t.close.mockRejectedValue(Error("cleanup private"));
    await expect(t.run()).rejects.toBe(primary); expect(t.client.candidate).not.toHaveBeenCalled();
    expect(JSON.stringify(primary["discoveryMetrics"])).not.toMatch(/private body|cleanup private/);
  });

  it("a cleanup failure after inspection prevents candidate/activation", async () => {
    const t = setup(); t.close.mockRejectedValue(Error("private cleanup"));
    await expect(t.run()).rejects.toMatchObject({ code: "FRAMEWORK_INSPECTION_CLOSE_FAILED" });
    expect(t.client.candidate).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
  });

  it("incomplete independent replay never becomes verification or activation; closed replay facts retain source routing for retry", async () => {
    const t = setup(); t.executeRecipe.mockResolvedValue({ status: "INCOMPLETE", complete: false, slots: [], evidence: { reason: "ADAPTER_IDENTITY_MISMATCH", raw: "PRIVATE_HTML" } });
    await expect(t.run()).rejects.toMatchObject({ code: "DISCOVERY_REPLAY_INCOMPLETE" });
    expect(t.client.verification).not.toHaveBeenCalled(); expect(t.client.activate).not.toHaveBeenCalled();
    expect(JSON.stringify(t.checkpoints)).not.toContain("PRIVATE_HTML");
    const last = t.checkpoints.at(-1) as { stagehandSource: { report: object }; stagehandProgress: { replay: { result: { complete: boolean } } } };
    expect(last.stagehandSource.report).toBeTruthy(); expect(last.stagehandProgress.replay.result.complete).toBe(false);
  });

  it("executes only server challenges, honors completed challenge flags, and drains replay checkpoint writes before activation hooks", async () => {
    const t = setup(); t.client.candidate.mockResolvedValue({ recipeHash: "b".repeat(64), challenges: [
      { id: "old-completed", recipeHash: "b".repeat(64), input: { players: 4 }, completed: true },
      { id: "fresh-challenge", recipeHash: "b".repeat(64), input: { ...t.f.job.request.input, date: "2030-01-05", players: 3 } },
    ] });
    await t.run(); expect(t.executeRecipe).toHaveBeenCalledOnce(); expect(t.client.verification).toHaveBeenCalledOnce();
    expect(t.executeRecipe.mock.calls[0][0].input.date).toBe("2030-01-05");
  });

  it("honors original work deadline and pre-existing cancellation without any source/model request", async () => {
    const t = setup(); t.f.clock = first + 720_000;
    await expect(t.run()).rejects.toMatchObject({ code: "DISCOVERY_WORK_DEADLINE" });
    expect(t.sourceDiscover).not.toHaveBeenCalled();
    t.f.clock = first + 2000; const abort = new AbortController(); abort.abort(Error("cancelled"));
    await expect(t.run({ signal: abort.signal })).rejects.toThrow("cancelled");
    expect(t.sourceDiscover).not.toHaveBeenCalled();
  });

  it("prepares only injected readiness before a claim, without constructing any model or browser", async () => {
    const ready = vi.fn(async args => ({ ready: true, cwd: args.cwd }));
    await expect(prepareCourseDiscoveryStagehandWorker({ cwd: "/owned-checkout", prepareSourceDiscovery: ready })).resolves.toMatchObject({ ready: true });
    expect(ready).toHaveBeenCalledWith({ cwd: "/owned-checkout" });
  });

  it("reports copied bounded metrics while diagnostic listener failure cannot alter activation", async () => {
    const t = setup(), samples: unknown[] = [];
    const result = await t.run({ onMetrics: value => { samples.push(value); value.modelCalls = 999; throw Error("listener private"); } });
    expect(samples.length).toBeGreaterThan(1); expect(result.metrics.modelCalls).toBe(2);
    expect(t.client.activate).toHaveBeenCalledOnce(); expect(JSON.stringify(samples)).not.toMatch(/PRIVATE_BACKEND_TOKEN|private-new-owned-lease/);
  });

  it.each(["https://public.example/?token=private", "https://public.example/ASP/appt_req.asp", "https://public.example/ASP%2fappt_req.asp", "https://127.0.0.1/", "https://public.example/login"])("never admits an unsafe or transaction source %s", url => {
    expect(publicStagehandSourceUrl(url)).toBe(false);
  });
  it("public integer memberStoreId routing remains exact and credential names stay denied", () => {
    expect(publicStagehandSourceUrl("https://public.example/read?memberStoreId=12")).toBe(true);
    expect(publicStagehandSourceUrl("https://public.example/read?memberStoreId=12&memberStoreId=13")).toBe(false);
    expect(publicStagehandSourceUrl("https://public.example/read?memberStoreId=private")).toBe(false);
  });
});
