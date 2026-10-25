import { createHash } from "node:crypto";
import { discoveryError } from "./course-discovery-client.mjs";
import { observedBookingSourceCandidates } from "./stagehand/source-provenance.mjs";

export const STAGEHAND_SOURCE_MODE = "HYBRID_SOURCE_DISCOVERY";
export const STAGEHAND_SOURCE_BUDGET_MS = 120_000;
export const STAGEHAND_CHECKPOINT_BYTES = 30_000;
export const canonicalStagehandData = value => Array.isArray(value) ? `[${value.map(canonicalStagehandData).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalStagehandData(item)}`).join(",")}}` : JSON.stringify(value);
export const stagehandDataHash = value => createHash("sha256").update(canonicalStagehandData(value)).digest("hex");
const requireFact = (condition, code) => { if (!condition) throw discoveryError(code); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Admission is separate from inert href evidence. This never grants a booking action. */
export function publicStagehandSourceUrl(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.href !== value || url.protocol !== "https:" || url.username || url.password || url.port ||
        !/^[a-z0-9][a-z0-9.-]*\.[a-z]+$/iu.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname)) return false;
    let pathname = url.pathname;
    for (let i = 0; i < 4; i++) { const decoded = decodeURIComponent(pathname); if (decoded === pathname) break; pathname = decoded; }
    if (pathname.includes("\\") || /(?:^|\/)(?:login|signin|signup|auth|account|checkout|cart|payment|pay|purchase|orders?|confirm|admin)(?:\/|$)/iu.test(pathname) ||
        /^\/ASP\/appt_req\.asp$/iu.test(pathname)) return false;
    const entries = [...url.searchParams];
    return entries.every(([key, item]) => key === "memberStoreId" && /^(?:0|[1-9]\d{0,9})$/u.test(item) && Number(item) <= 2147483647 && entries.filter(([name]) => name === key).length === 1 ||
      !/password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|customer|profile|account|member|user/iu.test(key));
  } catch { return false; }
}

export function stagehandWorkDeadline(job, workDeadlineAt) {
  const first = Date.parse(job?.firstPickedUpAt), absolute = Date.parse(job?.deadlineAt);
  requireFact(Number.isFinite(first) && Number.isFinite(absolute) && absolute - first === 900_000, "STAGEHAND_ORIGINAL_CLOCK_INVALID");
  const deadline = Math.min(absolute - 180_000, workDeadlineAt === undefined ? absolute : Date.parse(workDeadlineAt));
  requireFact(Number.isFinite(deadline) && deadline > first && deadline <= first + 720_000, "STAGEHAND_ORIGINAL_CLOCK_INVALID");
  return deadline;
}

export function publicStagehandJob(job) {
  const identity = Object.fromEntries(["name", "officialUrl", "timeZone", "address"].filter(key => job.request.identity[key] !== undefined).map(key => [key, job.request.identity[key]]));
  return { id: job.id, firstPickedUpAt: job.firstPickedUpAt, deadlineAt: job.deadlineAt,
    request: { identity, target: structuredClone(job.request.target), input: structuredClone(job.request.input) } };
}

export function validateStagehandSourceProposal(proposal) {
  requireFact(plain(proposal) && Reflect.ownKeys(proposal).length === 3 &&
    Object.keys(proposal).sort().join(",") === "bookingUrl,kind,schemaVersion" && proposal.schemaVersion === 1 &&
    proposal.kind === "EXISTING_ADAPTER_SOURCE" && publicStagehandSourceUrl(proposal.bookingUrl), "STAGEHAND_SOURCE_PROPOSAL_INVALID");
  return { schemaVersion: 1, kind: "EXISTING_ADAPTER_SOURCE", bookingUrl: proposal.bookingUrl };
}

/** A successful native report is still only routing evidence. */
export function stagehandSourceFailureCode(report, job) {
  const known = new Set(["STAGEHAND_NATIVE_HOST_DEADLINE", "STAGEHAND_NATIVE_HOST_SCOPE_INVALID", "STAGEHAND_NATIVE_HOST_INVALID",
    "STAGEHAND_NATIVE_HOST_FAILED", "STAGEHAND_GUARDED_SOURCE_REJECTED", "OWNED_STAGEHAND_CDP_UNAVAILABLE", "OWNED_PUBLIC_CDP_UNAVAILABLE",
    "PROVIDER_COORDINATION_UNAVAILABLE",
    "STAGEHAND_SOURCE_BUDGET_EXHAUSTED", "SOURCE_DISCOVERY_ABORTED", "WORK_DEADLINE_EXPIRED", "ADAPTER_SOURCE_NOT_OBSERVED",
    "FRAMEWORK_SOURCE_CANDIDATES_INVALID", "LOCAL_MODEL_EXISTING_CHATGPT_LOGIN_REQUIRED", "LOCAL_MODEL_TURN_FAILED",
    "LOCAL_MODEL_ORIGINAL_DEADLINE", "LOCAL_MODEL_CALL_CANCELLED", "SOL_ONLY_MODEL_RESULT_REQUIRED", "STAGEHAND_VERSION_CHANGED",
    "SOURCE_EVIDENCE_LIMIT", "STAGEHAND_GUARDED_BROWSER_REQUIRED", "STAGEHAND_UNGUARDED_CONTEXT", "STAGEHAND_GUARDED_TARGET_MISSING",
    "STAGEHAND_SOURCE_OUTPUT_INVALID", "STAGEHAND_SOURCE_DISCOVERY_FAILED", "STAGEHAND_SOURCE_CLEANUP_UNCONFIRMED"]);
  if (!plain(report) || report.outcome !== "UNRESOLVED" || !known.has(report.frameworkFailureCode) || report.jobId !== job.id ||
      report.firstPickedUpAt !== job.firstPickedUpAt || report.deadlineAt !== job.deadlineAt || report.framework?.name !== "Stagehand" ||
      report.framework.version !== "4.3.0" || report.frameworkMode !== STAGEHAND_SOURCE_MODE || report.frameworkRole !== "SOURCE_DISCOVERY_ONLY" ||
      report.frameworkExtractedTimes !== false || report.adapterSourceProposal !== null || report.recipe !== null || report.recipeJson != null ||
      report.result?.recipeJson != null || !Array.isArray(report.matchingSlots) || report.matchingSlots.length !== 0 ||
      report.metrics?.model !== "gpt-6.1-sol" || report.metrics.reasoningEffort !== "medium") return undefined;
  return report.frameworkFailureCode;
}

export function validateStagehandSourceReport(report, job) {
  requireFact(plain(report) && report.jobId === job.id && report.firstPickedUpAt === job.firstPickedUpAt && report.deadlineAt === job.deadlineAt &&
    report.framework?.name === "Stagehand" && report.framework.version === "4.3.0" && report.frameworkMode === STAGEHAND_SOURCE_MODE &&
    report.frameworkRole === "SOURCE_DISCOVERY_ONLY" && report.frameworkExtractedTimes === false &&
    report.outcome === "SOURCE_PROPOSED_UNVERIFIED" && report.browserClosed === true && report.modelClosed === true &&
    report.recipe === null && report.recipeJson == null && report.result?.recipeJson == null &&
    Array.isArray(report.matchingSlots) && report.matchingSlots.length === 0 &&
    report.metrics?.model === "gpt-6.1-sol" && report.metrics.reasoningEffort === "medium", "STAGEHAND_SOURCE_REPORT_INVALID");
  requireFact(!Array.isArray(report.metrics.localCodexCalls) || report.metrics.localCodexCalls.every(call =>
    call?.model === "gpt-6.1-sol" && (call.effort === undefined || call.effort === "medium")), "STAGEHAND_SOURCE_REPORT_INVALID");
  const sourceEnd = Math.min(Date.parse(job.firstPickedUpAt) + STAGEHAND_SOURCE_BUDGET_MS, stagehandWorkDeadline(job));
  const started = Date.parse(report.startedAt), completed = Date.parse(report.finishedAt);
  requireFact(Number.isFinite(started) && Number.isFinite(completed) && started >= Date.parse(job.firstPickedUpAt) - 5000 &&
    completed >= started && completed <= sourceEnd && Date.parse(report.workDeadlineAt) <= sourceEnd &&
    Date.parse(report.workDeadlineAt) > started, "STAGEHAND_SOURCE_CLOCK_INVALID");
  const proposal = validateStagehandSourceProposal(report.adapterSourceProposal);
  requireFact(observedBookingSourceCandidates(report, job.request.identity.officialUrl, publicStagehandSourceUrl,
    { sourceDiscoveryOnly: true }).includes(proposal.bookingUrl), "STAGEHAND_SOURCE_NOT_OBSERVED");
  return proposal;
}

function boundedRows(value, maximum) {
  requireFact(value === undefined || Array.isArray(value) && value.length <= maximum, "STAGEHAND_SOURCE_GRAPH_LIMIT");
  return value ?? [];
}
const urlField = value => publicStagehandSourceUrl(value) ? value : undefined;
/** Project original collector rows. No edges are synthesized and no oversized row list is truncated. */
export function stagehandRoutingReport(report, job) {
  validateStagehandSourceReport(report, job);
  const projected = {
    jobId: report.jobId, firstPickedUpAt: report.firstPickedUpAt, deadlineAt: report.deadlineAt,
    startedAt: report.startedAt, finishedAt: report.finishedAt, workDeadlineAt: report.workDeadlineAt,
    framework: { name: "Stagehand", version: "4.3.0" }, frameworkMode: STAGEHAND_SOURCE_MODE,
    frameworkRole: "SOURCE_DISCOVERY_ONLY", frameworkExtractedTimes: false, outcome: "SOURCE_PROPOSED_UNVERIFIED",
    browserClosed: true, modelClosed: true, recipe: null, matchingSlots: [], adapterSourceProposal: validateStagehandSourceProposal(report.adapterSourceProposal),
    metrics: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
    visitedUrls: boundedRows(report.visitedUrls, 512).filter(publicStagehandSourceUrl),
    officialLinkLedger: boundedRows(report.officialLinkLedger, 512).map(row => ({
      pageUrl: urlField(row.pageUrl), links: boundedRows(row.links, 512).filter(item => publicStagehandSourceUrl(item.href)).map(item => ({ href: item.href })),
    })).filter(row => row.pageUrl),
    frameLedger: boundedRows(report.frameLedger, 512).map(row => ({
      pageUrl: urlField(row.pageUrl), frames: boundedRows(row.frames, 32).filter(item => publicStagehandSourceUrl(item.src))
        .map(item => ({ src: item.src, visible: item.visible === true })),
    })).filter(row => row.pageUrl),
    actions: boundedRows(report.actions, 256).map(row => ({
      sourceUrl: urlField(row.sourceUrl), action: { method: row.action?.method === "click" ? "click" : "OTHER" },
      observedTarget: { tag: row.observedTarget?.tag === "A" ? "A" : "OTHER", href: urlField(row.observedTarget?.href) },
      afterUrl: urlField(row.afterUrl), ...(row.error || row.actionError ? { error: true } : {}),
    })).filter(row => row.sourceUrl && row.observedTarget.href && row.afterUrl),
  };
  if (report.initialNavigation) projected.initialNavigation = {
    requestedUrl: urlField(report.initialNavigation.requestedUrl), finalUrl: urlField(report.initialNavigation.finalUrl),
    status: Number.isInteger(report.initialNavigation.status) ? report.initialNavigation.status : 0,
  };
  validateStagehandSourceReport(projected, job);
  return projected;
}

export function createStagehandSourceCheckpoint(job, report) {
  requireFact(typeof job.sourceFingerprint === "string" && /^[a-f0-9]{64}$/u.test(job.sourceFingerprint) &&
    Number.isInteger(job.attempts) && [1, 2].includes(job.attempts), "STAGEHAND_SOURCE_SCOPE_INVALID");
  const routing = stagehandRoutingReport(report, job);
  const value = { schemaVersion: 1, kind: "OWN_STAGEHAND_SOURCE_EXPORT", jobId: job.id, sourceFingerprint: job.sourceFingerprint,
    requestSha256: stagehandDataHash(job.request), attempt: job.attempts, firstPickedUpAt: job.firstPickedUpAt, deadlineAt: job.deadlineAt,
    reportSha256: stagehandDataHash(routing), report: routing };
  requireFact(Buffer.byteLength(JSON.stringify(value), "utf8") <= STAGEHAND_CHECKPOINT_BYTES, "STAGEHAND_SOURCE_CHECKPOINT_LIMIT");
  return value;
}

export function readStagehandSourceCheckpoint(job, workDeadlineAt, now = Date.now()) {
  const value = job.checkpoint?.stagehandSource;
  if (value === undefined) return undefined;
  const keys = ["schemaVersion", "kind", "jobId", "sourceFingerprint", "requestSha256", "attempt", "firstPickedUpAt", "deadlineAt", "reportSha256", "report"];
  requireFact(plain(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)) &&
    job.attempts === 2 && value.attempt === 1 && value.schemaVersion === 1 && value.kind === "OWN_STAGEHAND_SOURCE_EXPORT" &&
    value.jobId === job.id && value.sourceFingerprint === job.sourceFingerprint && value.requestSha256 === stagehandDataHash(job.request) &&
    value.firstPickedUpAt === job.firstPickedUpAt && value.deadlineAt === job.deadlineAt &&
    value.reportSha256 === stagehandDataHash(value.report) &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= STAGEHAND_CHECKPOINT_BYTES, "STAGEHAND_SOURCE_RESUME_INVALID");
  requireFact(now < stagehandWorkDeadline(job, workDeadlineAt), "STAGEHAND_SOURCE_RESUME_DEADLINE");
  const reconstructed = createStagehandSourceCheckpoint({ ...job, attempts: 1 }, value.report);
  requireFact(canonicalStagehandData(reconstructed) === canonicalStagehandData(value), "STAGEHAND_SOURCE_RESUME_INVALID");
  return structuredClone(value);
}
