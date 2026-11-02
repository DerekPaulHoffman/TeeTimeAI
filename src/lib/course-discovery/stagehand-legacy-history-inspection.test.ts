import { describe, expect, it, vi } from "vitest";
import { inspectStagehandAdapter } from "../../../scripts/automation/course-discovery-stagehand-inspection.mjs";
import { createDiscoveryBrowser } from "../../../scripts/automation/course-discovery-worker.mjs";
import { stagehandDataHash as hash } from "../../../scripts/automation/course-discovery-stagehand-source.mjs";

describe("fresh legacy-provider document and history routing", () => {
  it.each(["valid", "missingRedirect", "foreignRedirect"])("advances a native canonical-root redirect already present in the learned path (%s)", async mode => {
    const now = Date.parse("2030-01-02T12:00:03.000Z"), stamp = new Date(now - 1000).toISOString();
    const official = "https://www.public-course.example/", alias = "https://public-course.example/", page = alias + "tee-times/";
    const booking = "https://public-course.ezlinksgolf.com/search", first = new Date(now - 3000).toISOString(), deadline = new Date(now + 897000).toISOString();
    const job = { id: "fixture-job", leaseToken: "fixture-private-lease", sourceFingerprint: "a".repeat(64), firstPickedUpAt: first, deadlineAt: deadline,
      request: { target: { kind: "OUTDOOR", courseId: "fixture-course" }, identity: { name: "Public Course", officialUrl: official, address: "1 Main St, Test City, CT 06000", timeZone: "America/New_York" },
        input: { date: "2030-01-03", timeZone: "America/New_York", players: 2, startTime: "09:00", endTime: "18:00" } } };
    const report = { schemaVersion: 1, jobId: job.id, firstPickedUpAt: first, deadlineAt: deadline, workDeadlineAt: new Date(now + 117000).toISOString(), startedAt: first, finishedAt: stamp,
      framework: { name: "Stagehand", version: "4.3.0" }, frameworkRole: "SOURCE_DISCOVERY_ONLY", frameworkExtractedTimes: false,
      outcome: "SOURCE_PROPOSED_UNVERIFIED", browserClosed: true, modelClosed: true, recipe: null, matchingSlots: [], frameworkMode: "HYBRID_SOURCE_DISCOVERY",
      adapterSourceProposal: { schemaVersion: 1, kind: "EXISTING_ADAPTER_SOURCE", bookingUrl: booking }, visitedUrls: [official, alias, page], frameLedger: [], actions: [],
      initialNavigation: { requestedUrl: official, finalUrl: alias, status: 200 },
      officialLinkLedger: [{ kind: "NATIVE_VISIBLE_DOM", pageUrl: alias, observedAt: stamp, documentHash: "a".repeat(64), links: [{ href: page, visible: true }] },
        { kind: "NATIVE_VISIBLE_DOM", pageUrl: page, observedAt: stamp, documentHash: "b".repeat(64), links: [{ href: booking, visible: true }] }],
      metrics: { model: "gpt-6.1-sol", reasoningEffort: "medium", localCodexCalls: [] } };
    let current = alias;
    const request = vi.fn(async ({ action, url }: { action: string; url?: string }) => {
      if (action === "inspect_adapter") throw Object.assign(Error("fixture adapter boundary"), { code: "ADAPTER_IDENTITY_MISMATCH" });
      if (action === "open") current = url === official ? alias : url!;
      return { url: current, browserTransport: "NATIVE_CHROME", navigationStatus: 200, accessRequirementObserved: false, loading: false, pendingRequestCount: 0,
        controls: [{ kind: "link", href: current === alias ? page : booking }], frames: [],
        ...(current === alias && mode !== "missingRedirect" ? { nativeDocumentRedirects: [{ fromUrl: mode === "foreignRedirect" ? "https://foreign.example/" : official, toUrl: alias, status: 301, completed: true }] } : {}),
        nativeMainDocumentContinuity: { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1", originalUrlSha256: hash(url === official ? official : current),
          currentUrlSha256: hash(current), documentBindingSha256: "c".repeat(64), observedAt: now, status: 200 },
        officialSourceDiagnostic: { rawOfficialCaptured: true, currentOfficialDocument: true, renderedAddressesPresent: true, renderedLinksPresent: true } };
    });
    const close = vi.fn(async () => {});
    const error = await inspectStagehandAdapter({ report, adapterSourceProposal: report.adapterSourceProposal, job, cwd: process.cwd(), workDeadlineAt: deadline, now: () => now,
      client: { helperEnvironment: () => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME", COURSE_DISCOVERY_JOB_KIND: "discovery", COURSE_DISCOVERY_JOB_ID: job.id, COURSE_DISCOVERY_LEASE_TOKEN: job.leaseToken }) },
      worker: { createDiscoveryBrowser: (options: unknown) => createDiscoveryBrowser({ ...options as object, processFactory: () => ({ request, close }) }) } }).then(() => undefined, (failure: Error & { code?: string }) => failure);
    expect(error).toBeDefined();
    expect(request.mock.calls.some(([v]) => v.action === "inspect_adapter"), error?.message).toBe(mode === "valid");
    if (mode === "valid") {
      expect(error?.code).toBe("ADAPTER_IDENTITY_MISMATCH");
      expect(request.mock.calls.filter(([v]) => v.action === "open").map(([v]) => v.url)).toEqual([official, page]);
    }
    expect(close, error?.message).toHaveBeenCalledOnce();
  });

  it.each(["valid", "noProof", "foreignDocument", "stale", "non200", "challenge"])("requires current owned continuity: %s", async mode => {
    const now = Date.parse("2030-01-02T12:00:03.000Z"), stamp = new Date(now - 1000).toISOString();
    const official = "https://public-course.example/", legacy = "https://public-course.ezlinks.com/";
    const served = "https://public-course.ezlinksgolf.com/", booking = served + "search";
    const first = new Date(now - 3000).toISOString(), deadline = new Date(now + 897000).toISOString();
    const job = { id: "fixture-job", leaseToken: "fixture-private-lease", sourceFingerprint: "a".repeat(64), firstPickedUpAt: first, deadlineAt: deadline,
      request: { target: { kind: "OUTDOOR", courseId: "fixture-course" }, demand: { searchId: "fixture-search", alertGeneration: 1 },
        identity: { name: "Public Course Golf", officialUrl: official, address: "10 Public Road, Example, MA 01010", timeZone: "America/New_York" },
        input: { date: "2030-01-03", players: 2, startTime: "09:00", endTime: "18:00", timeZone: "America/New_York" } } };
    const report = { framework: { name: "Stagehand", version: "4.3.0" }, frameworkMode: "HYBRID_SOURCE_DISCOVERY", frameworkRole: "SOURCE_DISCOVERY_ONLY",
      frameworkExtractedTimes: false, jobId: job.id, firstPickedUpAt: first, deadlineAt: deadline, workDeadlineAt: new Date(now + 117000).toISOString(),
      startedAt: first, finishedAt: stamp, outcome: "SOURCE_PROPOSED_UNVERIFIED", browserClosed: true, modelClosed: true, recipe: null, matchingSlots: [],
      adapterSourceProposal: { schemaVersion: 1, kind: "EXISTING_ADAPTER_SOURCE", bookingUrl: booking },
      visitedUrls: [official, served, booking], frameLedger: [],
      officialLinkLedger: [{ kind: "NATIVE_VISIBLE_DOM", pageUrl: official, observedAt: stamp, documentHash: "a".repeat(64), links: [{ href: legacy, visible: true }] },
        { kind: "NATIVE_VISIBLE_DOM", pageUrl: booking, observedAt: stamp, documentHash: "b".repeat(64), links: [] }],
      nativeHistoryNavigations: [{ kind: "NATIVE_DOCUMENT_HISTORY_ROUTE", documentUrl: served, finalUrl: booking, finalStatus: 200,
        observedAt: stamp, completedAt: stamp, documentHash: "b".repeat(64) }],
      actions: [{ sourceUrl: official, action: { method: "click" }, observedTarget: { tag: "A", href: legacy, text: "Public tee times", label: "", rowText: "" }, afterUrl: served }],
      initialNavigation: { requestedUrl: official, finalUrl: official, status: 200 }, metrics: { model: "gpt-6.1-sol", reasoningEffort: "medium", localCodexCalls: [] } };
    let current = official;
    const request = vi.fn(async ({ action, url }: { action: string; url?: string }) => {
      if (action === "inspect_adapter") throw Object.assign(Error("fixture terminal adapter boundary"), { code: "ADAPTER_IDENTITY_MISMATCH" });
      if (action === "open") current = url === legacy ? booking : url!;
      return { url: current, browserTransport: "NATIVE_CHROME", navigationStatus: mode === "non200" && current === booking ? 403 : 200,
        accessRequirementObserved: mode === "challenge" && current === booking, loading: false, pendingRequestCount: 0,
        controls: current === official ? [{ kind: "link", href: legacy }] : [], frames: [],
        officialSourceDiagnostic: { rawOfficialCaptured: current === official, currentOfficialDocument: current === official,
          renderedAddressesPresent: true, renderedLinksPresent: true },
        ...(mode === "noProof" && current === booking ? {} : { nativeMainDocumentContinuity: { kind: "NATIVE_MAIN_DOCUMENT_CONTINUITY_V1",
          originalUrlSha256: hash(current === booking && url === legacy ? mode === "foreignDocument" ? "https://foreign.example/" : served : current),
          currentUrlSha256: hash(current), documentBindingSha256: "c".repeat(64), observedAt: now - (mode === "stale" && current === booking ? 5001 : 0), status: 200 } }) };
    });
    const close = vi.fn(async () => {});
    const error = await inspectStagehandAdapter({ report, adapterSourceProposal: report.adapterSourceProposal, job, cwd: process.cwd(), workDeadlineAt: deadline,
      now: () => now, client: { helperEnvironment: () => ({ COURSE_DISCOVERY_BROWSER_TRANSPORT: "NATIVE_CHROME", COURSE_DISCOVERY_JOB_KIND: "discovery", COURSE_DISCOVERY_JOB_ID: job.id, COURSE_DISCOVERY_LEASE_TOKEN: job.leaseToken }) },
      worker: { createDiscoveryBrowser: (options: unknown) => createDiscoveryBrowser({ ...options as object, processFactory: () => ({ request, close }) }) } }).then(() => undefined, (failure: Error & { code?: string }) => failure);
    expect(error).toBeDefined();
    if (mode === "valid") expect(error?.code ?? error?.message).toBe("ADAPTER_IDENTITY_MISMATCH");
    const historyOpens = request.mock.calls.filter(([value]) => value.action === "open" && value.url === booking);
    expect(historyOpens).toHaveLength(mode === "valid" ? 1 : 0);
    expect(close).toHaveBeenCalledOnce();
  });
});
