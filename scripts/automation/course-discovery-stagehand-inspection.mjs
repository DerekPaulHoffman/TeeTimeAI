// Source-routing inspection only. No model, uploaded recipe, or cached proof is admitted here.
import { discoveryError } from "./course-discovery-client.mjs";
import { STAGEHAND_SOURCE_MODE, canonicalStagehandData as canonical, stagehandDataHash as hash,
  publicStagehandSourceUrl as publicUrl, validateStagehandSourceProposal as validateAdapterSourceProposal,
  validateStagehandSourceReport } from "./course-discovery-stagehand-source.mjs";
import { observedBookingSourceCandidates, nativeLinkSource, corroboratedNativeLink, nativeFrameNavigations, nativeIntermediaryNavigations, nativeGestureNavigations, nativeHistoryNavigations } from "./stagehand/source-provenance.mjs";
import { safeTeeItUpDelegationDiagnostic, safeFixedAdapterReadDiagnostic, safeFixedInspectionSourceDiagnostic, safeNativeMainDocumentContinuity } from "./course-discovery-worker.mjs";
import { z } from "zod";
import { setTimeout as waitForFrame } from "node:timers/promises";
import { projectNativeRouterFailure, safeNativeRouterFailure } from "./stagehand/source-diagnostic.mjs";
const fail = code => discoveryError(code), HYBRID_SOURCE_DISCOVERY = STAGEHAND_SOURCE_MODE;
const INSPECTION_ACTION_LIMIT = 6;
const inspectionFailures = new WeakMap();
const publicRoutingRecoveries = new WeakMap();
// Closed diagnostic mirror only; these values cannot admit a request or document.
const nativeFatalCodes = ["NATIVE_REDIRECT_ABORT_TIMEOUT", "NATIVE_REDIRECT_BODY_TIMEOUT", "NATIVE_REDIRECT_CANCELLED", "NATIVE_REDIRECT_CONTINUE_REJECTED",
  "NATIVE_REDIRECT_CROSS_HOST_RESOURCE_REJECTED", "NATIVE_REDIRECT_DRAIN_FAILED", "NATIVE_REDIRECT_DRAIN_TIMEOUT", "NATIVE_REDIRECT_DUPLICATE_FETCH_ID",
  "NATIVE_REDIRECT_FRAME_MISSING", "NATIVE_REDIRECT_FRAME_UNGUARDED", "NATIVE_REDIRECT_FULFILL_REJECTED", "NATIVE_REDIRECT_HANDLER_FAILED", "NATIVE_REDIRECT_HEADERS_LIMIT",
  "NATIVE_REDIRECT_INSTALL_FAILED", "NATIVE_REDIRECT_INTERCEPT_LIMIT", "NATIVE_REDIRECT_LOADER_MISMATCH", "NATIVE_REDIRECT_LOADER_TIMEOUT", "NATIVE_REDIRECT_NAVIGATION_REJECTED",
  "NATIVE_REDIRECT_NETWORK_FAILED", "NATIVE_REDIRECT_NETWORK_ID_MISSING", "NATIVE_REDIRECT_PING_UNSUPPORTED", "NATIVE_REDIRECT_POST_BODY_LIMIT", "NATIVE_REDIRECT_POST_BODY_MISSING",
  "NATIVE_REDIRECT_PROVENANCE_REJECTED", "NATIVE_REDIRECT_PROVENANCE_TIMEOUT", "NATIVE_REDIRECT_RECORD_LIMIT", "NATIVE_REDIRECT_REQUEST_REJECTED", "NATIVE_REDIRECT_REQUEST_TIMEOUT",
  "NATIVE_REDIRECT_RESOURCE_KIND_REJECTED", "NATIVE_REDIRECT_RESOURCE_REJECTED", "NATIVE_REDIRECT_RESPONSE_DUPLICATE", "NATIVE_REDIRECT_RESPONSE_FRAME_MISMATCH",
  "NATIVE_REDIRECT_RESPONSE_HEADERS_CONFLICT", "NATIVE_REDIRECT_RESPONSE_METHOD_MISMATCH", "NATIVE_REDIRECT_RESPONSE_MISMATCH", "NATIVE_REDIRECT_RESPONSE_NETWORK_MISMATCH",
  "NATIVE_REDIRECT_RESPONSE_PRIOR_FAILURE", "NATIVE_REDIRECT_RESPONSE_REQUEST_PAUSED", "NATIVE_REDIRECT_RESPONSE_STATUS_INVALID", "NATIVE_REDIRECT_RESPONSE_TIMEOUT",
  "NATIVE_REDIRECT_RESPONSE_UNADMITTED", "NATIVE_REDIRECT_RESPONSE_UNKNOWN", "NATIVE_REDIRECT_RESPONSE_URL_MISMATCH", "NATIVE_REDIRECT_RETIRED_DISPATCH", "NATIVE_REDIRECT_ROUTING_FAILED",
  "NATIVE_RESPONSE_LIMIT", "OWNED_STAGEHAND_CDP_UNAVAILABLE", "STAGEHAND_GUARDED_SOURCE_REJECTED", "UNKNOWN"];
const readabilityFailures = ["TRANSPORT_CHANGED", "PUBLIC_URL_REJECTED", "ACCESS_REQUIREMENT", "NATIVE_FATAL", "OPEN_STATUS_MISSING", "STATUS_REJECTED"];
const nullableFact = z.boolean().nullable(), digest = z.string().regex(/^[a-f0-9]{64}$/u);
const readabilitySchema = z.object({ action: z.enum(["open", "observe", "inspect_adapter", "click"]), actionIndex: z.number().int().min(1).max(6),
  currentUrlCategory: z.enum(["OFFICIAL_ORIGIN", "BOOKING_ORIGIN", "OTHER_PUBLIC_HTTPS", "NON_PUBLIC_OR_INVALID"]), currentUrlSha256: digest.nullable(),
  nativeTransport: nullableFact, navigationStatusPresent: z.boolean(), navigationStatus: z.number().int().min(100).max(599).nullable(),
  accessRequirementObserved: nullableFact, nativeFatalPresent: z.boolean(), nativeFatalCode: z.enum(nativeFatalCodes).nullable(),
  readyState: z.enum(["loading", "interactive", "complete"]).nullable(), pendingRequestCount: z.number().int().min(0).max(2048).nullable(),
  officialDocumentCurrent: nullableFact, frameCorrelation: z.null(), loaderCorrelation: z.null(),
  redirectHashes: z.array(z.object({ fromSha256: digest, toSha256: digest, status: z.number().int().min(300).max(399) }).strict()).max(5),
  redirectsOmitted: z.boolean(), failedPredicates: z.array(z.enum(readabilityFailures)).max(6),
}).strict();
export function safeInspectionReadability(value) {
  const result = z.array(readabilitySchema).min(1).max(INSPECTION_ACTION_LIMIT).safeParse(value);
  return result.success && new Set(result.data.map(row => row.actionIndex)).size === result.data.length ? result.data : undefined;
}
const landingSchema = z.object({
  position: z.number().int().min(0).max(5), pathLength: z.number().int().min(1).max(6),
  snapshotPathIndex: z.number().int().min(-1).max(5), logicalPathIndex: z.number().int().min(-1).max(5),
  remainingPathIndex: z.number().int().min(-1).max(5), nativeContextPresent: z.boolean(),
  expectedUrlSha256: digest, snapshotUrlSha256: digest, logicalUrlSha256: digest,
  nativeOriginalUrlSha256: digest.nullable(), frameParentPosition: z.number().int().min(-1).max(5),
  frameChildPosition: z.number().int().min(-1).max(5),
}).strict();
export function safeInspectionLandingDiagnostic(value) {
  const parsed = landingSchema.safeParse(value);
  return parsed.success && parsed.data.position < parsed.data.pathLength ? parsed.data : undefined;
}
export function inspectionLandingDiagnostic(snapshot, path, position, nativeContext, frameWitness) {
  if (!publicUrl(snapshot?.url) || !Array.isArray(path) || !path.every(publicUrl) || !path[position]) return undefined;
  const actual = new URL(snapshot.url).href, logical = new URL(nativeContext?.originalUrl ?? actual).href;
  return safeInspectionLandingDiagnostic({ position, pathLength: path.length,
    snapshotPathIndex: path.indexOf(actual), logicalPathIndex: path.indexOf(logical),
    remainingPathIndex: path.indexOf(logical, position), nativeContextPresent: Boolean(nativeContext),
    expectedUrlSha256: hash(path[position]), snapshotUrlSha256: hash(actual), logicalUrlSha256: hash(logical),
    nativeOriginalUrlSha256: nativeContext ? hash(nativeContext.originalUrl) : null,
    frameParentPosition: frameWitness ? path.indexOf(frameWitness.parentUrl) : -1,
    frameChildPosition: frameWitness ? path.indexOf(frameWitness.frameUrl) : -1,
  });
}
/** Existing snapshot facts only. No frame/loader correlation is exposed by this protocol. */
export function inspectionReadability(snapshot, action, actionIndex, officialUrl, bookingUrl) {
  const safeUrl = publicUrl(snapshot?.url), fact = value => typeof value === "boolean" ? value : null;
  let currentUrlCategory = "NON_PUBLIC_OR_INVALID";
  if (safeUrl) {
    currentUrlCategory = new URL(snapshot.url).origin === new URL(officialUrl).origin ? "OFFICIAL_ORIGIN" :
      new URL(snapshot.url).origin === new URL(bookingUrl).origin ? "BOOKING_ORIGIN" : "OTHER_PUBLIC_HTTPS";
  }
  const failedPredicates = [];
  if (snapshot?.browserTransport !== "NATIVE_CHROME") failedPredicates.push("TRANSPORT_CHANGED");
  if (!safeUrl) failedPredicates.push("PUBLIC_URL_REJECTED");
  if (snapshot?.accessRequirementObserved) failedPredicates.push("ACCESS_REQUIREMENT");
  if (snapshot?.nativeFirstFatal) failedPredicates.push("NATIVE_FATAL");
  if (action === "open" && !Number.isInteger(snapshot?.navigationStatus)) failedPredicates.push("OPEN_STATUS_MISSING");
  if (snapshot?.navigationStatus !== undefined && !(snapshot.navigationStatus >= 200 && snapshot.navigationStatus < 400)) failedPredicates.push("STATUS_REJECTED");
  const redirects = Array.isArray(snapshot?.nativeDocumentRedirects) ? snapshot.nativeDocumentRedirects : [];
  const redirectHashes = redirects.slice(0, 5).filter(row => row?.completed === true && publicUrl(row.fromUrl) && publicUrl(row.toUrl) &&
    Number.isInteger(row.status) && row.status >= 300 && row.status < 400).map(row => ({ fromSha256: hash(row.fromUrl), toSha256: hash(row.toUrl), status: row.status }));
  return { action, actionIndex, currentUrlCategory, currentUrlSha256: safeUrl ? hash(snapshot.url) : null,
    nativeTransport: typeof snapshot?.browserTransport === "string" ? snapshot.browserTransport === "NATIVE_CHROME" : null,
    navigationStatusPresent: snapshot?.navigationStatus !== undefined,
    navigationStatus: Number.isInteger(snapshot?.navigationStatus) && snapshot.navigationStatus >= 100 && snapshot.navigationStatus <= 599 ? snapshot.navigationStatus : null,
    accessRequirementObserved: fact(snapshot?.accessRequirementObserved), nativeFatalPresent: Boolean(snapshot?.nativeFirstFatal),
    nativeFatalCode: snapshot?.nativeFirstFatal ? nativeFatalCodes.includes(snapshot.nativeFirstFatal.code) ? snapshot.nativeFirstFatal.code : "UNKNOWN" : null,
    readyState: ["loading", "interactive", "complete"].includes(snapshot?.readyState) ? snapshot.readyState : null,
    pendingRequestCount: Number.isInteger(snapshot?.pendingRequestCount) && snapshot.pendingRequestCount >= 0 && snapshot.pendingRequestCount <= 2048 ? snapshot.pendingRequestCount : null,
    officialDocumentCurrent: fact(snapshot?.officialSourceDiagnostic?.currentOfficialDocument), frameCorrelation: null, loaderCorrelation: null,
    redirectHashes, redirectsOmitted: redirects.length !== redirectHashes.length, failedPredicates };
}
/** Current invocation only. Copied receipts and prior attempts cannot supply facts. */
export function currentStagehandInspectionDiagnostic(error, job, startedAt, now) {
  try {
    const value = error && typeof error === 'object' ? inspectionFailures.get(error) : undefined;
    if (!value || value.job !== job || value.attempt !== job.attempts || value.requestSha256 !== hash(canonical(job.request)) ||
        value.sourceFingerprint !== job.sourceFingerprint || value.firstPickedUpAt !== job.firstPickedUpAt || value.deadlineAt !== job.deadlineAt ||
        !Number.isFinite(startedAt) || !Number.isFinite(now) || value.startedAt < startedAt || value.startedAt > now) return undefined;
    const teeItUpDelegation = safeTeeItUpDelegationDiagnostic(value.teeItUpDelegation);
    const adapterRead = safeFixedAdapterReadDiagnostic(value.adapterRead);
    const readability = safeInspectionReadability(value.readability);
    const landing = safeInspectionLandingDiagnostic(value.landing);
    const nativeRouterFailure = safeNativeRouterFailure(value.nativeRouterFailure);
    const fixedSource = safeFixedInspectionSourceDiagnostic(value);
    return teeItUpDelegation || adapterRead || readability || landing || nativeRouterFailure || fixedSource ? {
      ...(teeItUpDelegation ? { teeItUpDelegation } : {}), ...(adapterRead ? { adapterRead } : {}),
      ...(readability ? { readability } : {}),
      ...(landing ? { landing } : {}),
      ...(nativeRouterFailure ? { nativeRouterFailure } : {}),
      ...(fixedSource ?? {}),
    } : undefined;
  } catch { return undefined; }
}
/** Current private readability permits a fresh investigation, never a recipe. */
export function currentStagehandPublicRoutingRecovery(error, job, startedAt, now) {
  try {
    const value = error && typeof error === 'object' ? publicRoutingRecoveries.get(error) : undefined;
    if (!value || value.job !== job || value.jobId !== job.id || value.leaseTokenSha256 !== hash(job.leaseToken) || value.attempt !== job.attempts || value.requestSha256 !== hash(canonical(job.request)) ||
        value.sourceFingerprint !== job.sourceFingerprint || value.firstPickedUpAt !== job.firstPickedUpAt || value.deadlineAt !== job.deadlineAt ||
        !Number.isFinite(startedAt) || !Number.isFinite(now) || value.startedAt < startedAt || value.startedAt > now ||
        !Number.isFinite(value.observedAt) || value.observedAt > now || now - value.observedAt > 5000 || now >= Date.parse(value.deadlineAt)) return;
    const readability = safeInspectionReadability(value.readability);
    return readability ? { code: value.code, lastAction: value.lastAction, readability } : undefined;
  } catch { return; }
}
function canonicalAdapterSourceRecipe(proposal, job) {
  return { schemaVersion: 1, engine: "EXISTING_ADAPTER", target: { ...job.request.target }, source: {
    officialUrl: job.request.identity.officialUrl, bookingUrl: proposal.bookingUrl,
    venueName: job.request.identity.name, timeZone: job.request.input.timeZone,
    ...(job.request.identity.address ? { venueAddress: job.request.identity.address } : {}),
  } };
}
function observedSourceEvidence(report, identity) {
  const official = identity.officialUrl;
  const observed = new Set(report.visitedUrls ?? []);
  for (const row of report.officialLinkLedger ?? []) if (publicUrl(row.pageUrl)) observed.add(row.pageUrl);
  for (const row of report.frameLedger ?? []) if (publicUrl(row.pageUrl)) observed.add(row.pageUrl);
  const initial = report.initialNavigation;
  if (initial?.requestedUrl === official && initial.status >= 200 && initial.status < 400 &&
      publicUrl(initial.finalUrl) && observed.has(initial.finalUrl)) observed.add(official);
  if (!observed.has(official)) throw fail("FRAMEWORK_OFFICIAL_SOURCE_NOT_OBSERVED");
}
export function isReviewedCpsSourceEntry(value) {
  if (!publicUrl(value)) return false;
  try {
    const url = new URL(value), match = /^([a-z][a-z0-9-]*)\.cps\.golf$/u.exec(url.hostname);
    if (url.href !== value || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !match ||
        !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(match[1]) ||
        /^(?:www|api|admin|auth|login|account|private|member|test|staging)$/u.test(match[1]) ||
        !['/', '/onlineresweb/search-teetime'].includes(url.pathname)) return false;
    if (!url.search) return true;
    if (url.pathname !== '/onlineresweb/search-teetime') return false;
    const fields = url.search.slice(1).split('&');
    if (fields.length !== 2 || fields.some(field => !/^(?:TeeOffTimeMin|TeeOffTimeMax)=(?:0|[1-9]\d?)(?:\.\d{1,15})?$/u.test(field)) ||
        new Set([...url.searchParams.keys()]).size !== 2) return false;
    const min = Number(url.searchParams.get('TeeOffTimeMin')), max = Number(url.searchParams.get('TeeOffTimeMax'));
    return min >= 0 && min <= max && max < 24;
  } catch { return false; }
}

export function observedInspectionPath(report, officialUrl, bookingUrl) {
  if (!publicUrl(officialUrl) || !publicUrl(bookingUrl)) throw fail('FRAMEWORK_INSPECTION_SOURCE_INVALID');
  const norm = value => new URL(value).href, edges = new Map();
  let edgeCount = 0;
  const link = (from, to) => {
    if (!publicUrl(from) || !publicUrl(to)) return;
    const source = norm(from), target = norm(to);
    if (!edges.has(source)) edges.set(source, new Set());
    if (!edges.get(source).has(target)) {
      if (++edgeCount > 2048 || edges.size > 512) throw fail('FRAMEWORK_INSPECTION_GRAPH_LIMIT');
      edges.get(source).add(target);
    }
  };
  for (const row of (report.officialLinkLedger ?? []).slice(0, 512))
    for (const item of (row.links ?? []).slice(0, 512)) {
      if(row.kind==='NATIVE_PUBLIC_BOOKING_INTERMEDIARY'&&!nativeIntermediaryNavigations(report,publicUrl).some(entry=>entry.pageUrl===row.pageUrl&&entry.observedAt===row.observedAt&&entry.documentHash===row.documentHash&&entry.url===item.href))continue;
      link(row.pageUrl, item.href);
    }
  for (const row of (report.frameLedger ?? []).slice(0, 512))
    for (const frame of (row.frames ?? []).slice(0, 32)) link(row.pageUrl, frame.src);
  for (const row of nativeFrameNavigations(report, publicUrl)) for (const hop of row.redirects) link(hop.fromUrl, hop.toUrl);
  for (const row of nativeIntermediaryNavigations(report, publicUrl)) for (const hop of row.redirects) link(hop.fromUrl, hop.toUrl);
  for (const row of nativeGestureNavigations(report, publicUrl)) {
    link(row.pageUrl, row.targetUrl);
    for (const hop of row.redirects) link(hop.fromUrl, hop.toUrl);
  }
  for (const row of nativeHistoryNavigations(report, publicUrl)) link(row.documentUrl, row.finalUrl);
  for (const row of (report.observedSourceEvidence ?? []).slice(0, 1024)) {
    const source = row.kind === 'NATIVE_DOM_LINK_OBSERVED' ? nativeLinkSource(row) : row.url;
    if (['DOM_OBSERVED', 'NATIVE_DOM_LINK_OBSERVED'].includes(row.kind)) {
      for (const target of [...(row.exactObservedHrefs ?? []).slice(0, 512), ...(row.exactObservedFrameUrls ?? []).slice(0, 32)])
        if (row.kind !== 'NATIVE_DOM_LINK_OBSERVED' || corroboratedNativeLink(row, target, report)) link(source, target);
    }
    if (row.kind === 'NETWORK_DOCUMENT' && row.completedAt && row.status >= 300 && row.status < 400) link(row.url, row.redirectTo);
  }
  const initial = report.initialNavigation;
  if (initial?.requestedUrl === officialUrl && initial.status >= 200 && initial.status < 400) link(officialUrl, initial.finalUrl);
  // A real official-anchor navigation may add provider routing defaults.
  // The bridge still opens its bare observed href; only a matching fresh landing can skip this edge.
  for (const row of [...(report.actions ?? []).slice(0, 256), ...(report.observedNavigationActions ?? []).slice(0, 256)]) {
    const href = row.observedTarget?.href;
    if ((row.action?.method === 'click' || row.kind === 'PUBLIC_LINK_CLICK') &&
        String(row.observedTarget?.tag).toUpperCase() === 'A' && publicUrl(row.sourceUrl) &&
        norm(row.sourceUrl) === norm(officialUrl) && publicUrl(href) && publicUrl(row.afterUrl) &&
        edges.get(norm(officialUrl))?.has(norm(href))) {
      const anchor = new URL(href), landing = new URL(row.afterUrl);
      if (!anchor.search && !anchor.hash && !landing.hash && anchor.origin === landing.origin && anchor.pathname === landing.pathname)
        link(href, row.afterUrl);
    }
  }
  const start = norm(officialUrl), end = norm(bookingUrl), queue = [[start]], seen = new Set([start]);
  for (const path of queue) {
    if (path.at(-1) === end) return path;
    // At most five opens (the final link need not be opened) and one inspection.
    if (path.length >= INSPECTION_ACTION_LIMIT) continue;
    for (const next of edges.get(path.at(-1)) ?? []) if (!seen.has(next)) { seen.add(next); queue.push([...path, next]); }
  }
  throw fail('FRAMEWORK_INSPECTION_PATH_NOT_OBSERVED');
}

/** Report edges constrain one fixed inspection; a fresh native DOM match still owns admission. */
export function fixedInspectionFrameWitness(report, path, officialUrl) {
  if (!Array.isArray(path) || path.length < 2 || path.length > INSPECTION_ACTION_LIMIT ||
      !publicUrl(officialUrl) || path[0] !== officialUrl) throw fail('FRAMEWORK_INSPECTION_SCOPE_INVALID');
  const frames = nativeFrameNavigations(report, publicUrl).filter(row =>
    path.some((url, index) => index + 1 < path.length && row.pageUrl === url && row.frameUrl === path[index + 1]));
  if (frames.length > 1) throw fail('FRAMEWORK_INSPECTION_SCOPE_INVALID');
  let frame = frames[0];
  if (!frame) {
    // Source discovery may stop at an unclicked private visible-frame witness.
    // This constrains the fresh helper's existing exact DOM capability; it
    // neither admits the historical frame nor supplies identity/availability.
    const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
    const started = Date.parse(report?.startedAt), finished = Date.parse(report?.finishedAt), candidates = new Map();
    for (const row of (report.frameLedger ?? []).slice(0, 512)) {
      if (row?.kind !== 'NATIVE_VISIBLE_FRAME') continue;
      const stamp = Date.parse(row.observedAt);
      if (keys(row) !== 'documentHash,frames,kind,observedAt,pageUrl' ||
          !publicUrl(row.pageUrl) || new URL(row.pageUrl).href !== row.pageUrl || !report.visitedUrls?.includes(row.pageUrl) ||
          !Number.isFinite(started) || !Number.isFinite(finished) || !Number.isFinite(stamp) ||
          new Date(stamp).toISOString() !== row.observedAt || stamp < started || stamp > finished ||
          !/^[a-f0-9]{64}$/u.test(row.documentHash ?? '') || !Array.isArray(row.frames) || row.frames.length > 24 ||
          new Set(row.frames.map(item => item?.src)).size !== row.frames.length || row.frames.some(item =>
            keys(item) !== 'src,visible' || item.visible !== true || !publicUrl(item.src) ||
            new URL(item.src).href !== item.src || item.src === row.pageUrl)) continue;
      for (const item of row.frames) if (path.some((url, index) => index + 1 < path.length && row.pageUrl === url && item.src === path[index + 1]))
        candidates.set(canonical([row.pageUrl, item.src]), { pageUrl: row.pageUrl, frameUrl: item.src });
    }
    if (candidates.size > 1) throw fail('FRAMEWORK_INSPECTION_SCOPE_INVALID');
    frame = candidates.values().next().value;
  }
  return frame ? { kind: 'FIXED_INSPECTION_SOURCE_FRAME', officialUrl, parentUrl: frame.pageUrl,
    frameUrl: frame.frameUrl, sourceReportSha256: hash(canonical(report)) } : undefined;
}

/** A report edge never substitutes for the current child browser's private frame tag. */
export function freshFixedInspectionFrameEdge(snapshot, witness, next) {
  return Boolean(witness && next === witness.frameUrl && snapshot?.url === witness.parentUrl &&
    (snapshot.frames ?? []).some(row => row.source === 'FIXED_INSPECTION_FRAME_SRC' && row.url === next));
}

export function incompleteInspectionOfficial(snapshot, completedNativeTerminal, freshFixedFrameEdge, exactNextPresent) {
  const diagnostic = snapshot?.officialSourceDiagnostic;
  return !freshFixedFrameEdge && !completedNativeTerminal && diagnostic?.rawOfficialCaptured === true &&
    (diagnostic.currentOfficialDocument === false ||
      diagnostic.renderedHeadingsPresent === false && diagnostic.renderedAddressesPresent === false &&
      !(diagnostic.currentOfficialDocument === true && exactNextPresent));
}


/** The fresh owned native helper alone can attest these official document hops. */
export function freshNativeOfficialRedirects(snapshot,expectedRoot,currentUrl){
 const hops=snapshot?.nativeDocumentRedirects;
 if(snapshot?.browserTransport!=='NATIVE_CHROME'||snapshot.navigationStatus!==200||!Array.isArray(hops)||!hops.length||hops.length>5||!publicUrl(expectedRoot)||!publicUrl(currentUrl))return null;
 let previous=expectedRoot;const seen=new Set([previous]);
 for(const hop of hops){
  if(!hop||hop.completed!==true||![301,302,303,307,308].includes(hop.status)||hop.fromUrl!==previous||!publicUrl(hop.toUrl)||new URL(hop.toUrl).href!==hop.toUrl||seen.has(hop.toUrl))return null;
  seen.add(hop.toUrl);previous=hop.toUrl;
 }
 return previous===currentUrl&&snapshot.url===currentUrl?hops:null;
}

/** A bare observed Acuity tenant is research routing, never an API owner key.
 * Adopt only its current private completed same-origin HTTP destination, then
 * reopen that exact URL for independent canonical inspection/replay binding. */
export function currentAcuityInspectionRedirect(snapshot, root, context, browser, now) {
  try {
    const from = new URL(root), to = new URL(snapshot.url);
    if (!publicUrl(root) || from.href !== root || from.protocol !== 'https:' || from.port || from.username || from.password ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.as\.me$/u.test(from.hostname) || from.pathname !== '/' || from.search || from.hash ||
        !publicUrl(snapshot.url) || to.href !== snapshot.url || to.origin !== from.origin || to.search || to.hash ||
        !/^\/schedule\/[a-zA-Z0-9]{4,40}$/u.test(to.pathname) || snapshot.browserTransport !== 'NATIVE_CHROME' ||
        snapshot.navigationStatus !== 200 || snapshot.accessRequirementObserved || snapshot.nativeFirstFatal ||
        context?.originalUrl !== root || context.currentUrl !== snapshot.url) return;
    const proof = safeNativeMainDocumentContinuity(browser.currentMainDocumentContinuity?.(snapshot, root, now));
    if (!proof || proof.originalUrlSha256 !== hash(root) || proof.currentUrlSha256 !== hash(snapshot.url) ||
        proof.documentBindingSha256 !== context.capability.documentBindingSha256 || proof.observedAt > now || now - proof.observedAt > 5000) return;
    const hops = snapshot.nativeRoutingDocumentRedirects;
    if (!Array.isArray(hops) || !hops.length || hops.length > 5) return;
    let previous = root; const seen = new Set([root]);
    for (const hop of hops) {
      if (hop?.completed !== true || ![301,302,303,307,308].includes(hop.status) || hop.fromUrl !== previous ||
          !publicUrl(hop.toUrl) || new URL(hop.toUrl).href !== hop.toUrl || new URL(hop.toUrl).origin !== from.origin || seen.has(hop.toUrl)) return;
      const destination = new URL(hop.toUrl);
      if (destination.search || destination.hash || !['/', '/schedule.php'].includes(destination.pathname) && !/^\/schedule\/[a-zA-Z0-9]{4,40}$/u.test(destination.pathname)) return;
      seen.add(hop.toUrl); previous = hop.toUrl;
    }
    return previous === snapshot.url ? snapshot.url : undefined;
  } catch { return; }
}

export function numericMetrics(value, depth = 0) {
  if (depth > 6) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 128).map(item => numericMetrics(item, depth + 1)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 100).filter(([name]) => /^[A-Za-z][A-Za-z0-9_]{0,70}$/u.test(name) &&
    !/secret|token(?!s)|cookie|credential|authorization|api.?key|email|phone|url|headers?|body/iu.test(name))
    .map(([name, item]) => [name, numericMetrics(item, depth + 1)]).filter(([, item]) => item !== undefined));
}

export function closedFilterDiagnostics(error){
 try{
  const d=error?.details?.browserDiagnostics?.mindbodyAppointment,s=d?.filterSettlement;
  if(d?.stage!=='FILTER_SETTLEMENT'||!s||typeof s!=='object'||Array.isArray(s))return undefined;
  const out={};
  for(const k of ['sourceControlBound','newDocumentObserved','currentDocument','controlIsCategory'])
   if(typeof s[k]==='boolean')out[k]=s[k];
  for(const k of ['categorySelected','serviceSelected','expectedControlPresent','expectedControlSelected'])
   if(typeof s[k]==='boolean'||s[k]===null)out[k]=s[k];
  for(const [k,max]of [['pendingReads',2048],['elapsedMs',90000]])
   if(Number.isSafeInteger(s[k])&&s[k]>=0&&s[k]<=max)out[k]=s[k];
  return Object.keys(out).length?{stage:'FILTER_SETTLEMENT',filterSettlement:out}:undefined;
 }catch{return undefined;}
}
const inspectionCodes = new Set(["FRAMEWORK_HYBRID_REPORT_INVALID","FRAMEWORK_SOURCE_PROPOSAL_WITH_RECIPE","FRAMEWORK_INSPECTION_CANCELLED","FRAMEWORK_INSPECTION_DEADLINE","FRAMEWORK_INSPECTION_ENGINE_INVALID","FRAMEWORK_HYBRID_SOURCE_NOT_ELIGIBLE","FRAMEWORK_INSPECTION_SCOPE_INVALID","FRAMEWORK_INSPECTION_ACTION_LIMIT","FRAMEWORK_INSPECTION_TRANSPORT_CHANGED","FRAMEWORK_INSPECTION_SOURCE_UNREADABLE","FRAMEWORK_INSPECTION_CONTEXT_CHANGED","FRAMEWORK_INSPECTION_LANDING_CHANGED","FRAMEWORK_INSPECTION_SOURCE_NOT_SETTLED","FRAMEWORK_INSPECTION_PATH_STALE","FRAMEWORK_INSPECTION_SOURCE_CONTEXT_CHANGED","FRAMEWORK_INSPECTION_METADATA_INVALID","FRAMEWORK_INSPECTION_METADATA_CONFLICT","FRAMEWORK_INSPECTION_PROOF_NOT_BOUND","FRAMEWORK_INSPECTION_OBSERVATION_INVALID","FRAMEWORK_INSPECTION_CLOSE_FAILED","FRAMEWORK_INSPECTION_RECEIPT_FAILED",
  "OFFICIAL_CONTACT_SOURCE_UNVERIFIED", "OFFICIAL_CONTACT_READER_UNAVAILABLE", "OFFICIAL_CONTACT_ROOT_READ_UNVERIFIED",
  "OFFICIAL_CONTACT_ROOT_LINK_UNVERIFIED", "OFFICIAL_CONTACT_PAGE_READ_UNVERIFIED", "OFFICIAL_CONTACT_DOCUMENT_UNVERIFIED",
  "OFFICIAL_CONTACT_DEADLINE_EXCEEDED", "OFFICIAL_CONTACT_CHAIN_READ_UNVERIFIED",
  "OFFICIAL_CONTACT_DIRECTORY_BIND_UNVERIFIED", "OFFICIAL_CONTACT_DIRECTORY_READ_UNVERIFIED", "CPS_PHONE_BOOKING_SOURCE_UNVERIFIED", "CPS_OFFICIAL_ENTRY_UNVERIFIED"]);
export const inspectionErrorCode = error => inspectionCodes.has(error?.code) ? error.code : "STAGEHAND_FIXED_INSPECTION_FAILED";
export async function inspectStagehandAdapter({ report, adapterSourceProposal, job, worker, client, cwd, workDeadlineAt, signal,
  now = Date.now, onReceipt = () => {} }) {
  validateStagehandSourceReport(report, job);
  const mode = HYBRID_SOURCE_DISCOVERY;
  let recipe;
  const sourceOnly = recipe === null || recipe === undefined;
  if (mode === HYBRID_SOURCE_DISCOVERY && (!sourceOnly || canonical(adapterSourceProposal) !== canonical(report.adapterSourceProposal)))
    throw fail('FRAMEWORK_HYBRID_REPORT_INVALID');
  const proposal = sourceOnly ? validateAdapterSourceProposal(adapterSourceProposal) : undefined;
  if (!sourceOnly && adapterSourceProposal != null) throw fail('FRAMEWORK_SOURCE_PROPOSAL_WITH_RECIPE');
  recipe = canonicalAdapterSourceRecipe(proposal, job);
  const startedAt = now();
  const deadline = Math.min(Date.parse(job.deadlineAt), Date.parse(workDeadlineAt), startedAt + 180_000);
  const receipt = { schemaVersion: 1, jobSha256: hash(String(job.id)), requestSha256: hash(canonical(job.request)),
    sourceSha256: hash(canonical(recipe.source)),
    ...(sourceOnly ? { sourceProposalSha256: hash(canonical(proposal)) } : { proposedAdapterSha256: hash(canonical(recipe.adapter)) }),
    candidateOrigin: sourceOnly ? 'FRAMEWORK_SOURCE_PROPOSAL' : 'FRAMEWORK_RECIPE',
    frameworkMode: mode, frameworkRole: mode === HYBRID_SOURCE_DISCOVERY ? 'SOURCE_DISCOVERY_ONLY' : 'NATIVE_FRAMEWORK',
    ...(mode === HYBRID_SOURCE_DISCOVERY ? { methodAuthority: 'FIXED_READER', verifiedTimesAuthority: 'FIXED_READER' } : {}),
    frameworkRecipeArtifactPresent: !sourceOnly,
    frameworkReportedMatchingSlotCount: Array.isArray(report.matchingSlots) ? Math.min(report.matchingSlots.length, 500) : 0,
    frameworkReportedTimesAreVerificationProof: false,
    metadataFillRequested: sourceOnly, controllerFilledKnownMetadata: false,
    firstPickedUpAt: job.firstPickedUpAt, originalDeadlineAt: job.deadlineAt,
    startedAt: new Date(startedAt).toISOString(), actionLimit: INSPECTION_ACTION_LIMIT, actions: [],
    modelCalls: 0, browserClosed: false, outcome: 'INCOMPLETE' };
  let browser, primary, result, lastPublicRoutingRead;
  let browserClosedClean = false;
  const check = () => {
    if (signal?.aborted) throw fail('FRAMEWORK_INSPECTION_CANCELLED');
    if (!Number.isFinite(deadline) || now() >= deadline) throw fail('FRAMEWORK_INSPECTION_DEADLINE');
  };
  try {
    check();
    if (recipe.engine !== 'EXISTING_ADAPTER') throw fail('FRAMEWORK_INSPECTION_ENGINE_INVALID');
    // Recheck source authority locally before constructing any helper.
    observedSourceEvidence(report, job.request.identity, recipe, job.request.input,{sourceDiscoveryOnly:mode===HYBRID_SOURCE_DISCOVERY});
    if(mode===HYBRID_SOURCE_DISCOVERY&&!observedBookingSourceCandidates(report,job.request.identity.officialUrl,publicUrl,{sourceDiscoveryOnly:true}).includes(recipe.source.bookingUrl))throw fail('FRAMEWORK_HYBRID_SOURCE_NOT_ELIGIBLE');
    const path = observedInspectionPath(report, job.request.identity.officialUrl, recipe.source.bookingUrl);
    const frameWitness = fixedInspectionFrameWitness(report, path, job.request.identity.officialUrl);
    const earlyCpsContext = mode === HYBRID_SOURCE_DISCOVERY && sourceOnly && isReviewedCpsSourceEntry(recipe.source.bookingUrl);
    receipt.pathSha256 = hash(canonical(path)); receipt.pathLength = path.length;
    const environment = client.helperEnvironment('discovery', job);
    if (environment.COURSE_DISCOVERY_BROWSER_TRANSPORT !== 'NATIVE_CHROME' ||
        environment.COURSE_DISCOVERY_JOB_ID !== job.id || environment.COURSE_DISCOVERY_JOB_KIND !== 'discovery' ||
        environment.COURSE_DISCOVERY_LEASE_TOKEN !== job.leaseToken) throw fail('FRAMEWORK_INSPECTION_SCOPE_INVALID');
    const inspectionSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, deadline - now()))]);
    browser = await worker.createDiscoveryBrowser({ cwd, deadlineAt: new Date(deadline).toISOString(),
      fixedInspection: true, ...(frameWitness ? { fixedInspectionFrameWitness: frameWitness } : {}),
      initialUrls: [job.request.identity.officialUrl], timeZone: job.request.input.timeZone,
      requestedInput: job.request.input,
      ...(job.request.trustedContext!==undefined?{trustedContext:job.request.trustedContext}:{}),
      venueName: job.request.identity.name, venueAddress: job.request.identity.address,
      venueOfficialUrl: job.request.identity.officialUrl, helperEnvironment: environment, signal: inspectionSignal });
    const nativeContexts = new WeakMap();
    let currentNativeContext;
    const nativeContextMatches = (snapshot, expectedUrl, documentBinding) => {
      const current = nativeContexts.get(snapshot);
      return Boolean(current && current.originalUrl === expectedUrl && current.capability.currentUrlSha256 === hash(snapshot.url) &&
        (!documentBinding || current.capability.documentBindingSha256 === documentBinding));
    };
    const contextMatches = (snapshot, expectedUrl) => snapshot.url === expectedUrl || nativeContextMatches(snapshot, expectedUrl);
    const request = async (action, url, observeReason, target, expectedGesture) => {
      check();
      lastPublicRoutingRead = undefined;
      if (receipt.actions.length >= INSPECTION_ACTION_LIMIT) throw fail('FRAMEWORK_INSPECTION_ACTION_LIMIT');
      const start = now(), step = { action, urlSha256: hash(url), startedOffsetMs: Math.max(0, start - startedAt) };
      if (observeReason) step.observeReason = observeReason;
      receipt.actions.push(step);
      try {
        const previousContext = currentNativeContext;
        const snapshot = await browser.request(action === 'observe' ? { action } : action === 'click' ? { action, target } : { action, url }); check();
        // Record before the unchanged guard: an unreadable snapshot must remain diagnosable.
        try { step.readability = inspectionReadability(snapshot, action, receipt.actions.length, job.request.identity.officialUrl, recipe.source.bookingUrl); }
        catch { /* Optional diagnostic capture cannot replace the original guard. */ }
        try { Object.assign(step, safeFixedInspectionSourceDiagnostic(snapshot)); }
        catch { /* Optional diagnostic capture cannot replace the original guard. */ }
        if (snapshot?.browserTransport !== 'NATIVE_CHROME') throw fail('FRAMEWORK_INSPECTION_TRANSPORT_CHANGED');
        if (!publicUrl(snapshot.url) || snapshot.accessRequirementObserved || snapshot.nativeFirstFatal ||
            action === 'open' && !Number.isInteger(snapshot.navigationStatus) ||
            snapshot.navigationStatus !== undefined && !(snapshot.navigationStatus >= 200 && snapshot.navigationStatus < 400))
          throw fail('FRAMEWORK_INSPECTION_SOURCE_UNREADABLE');
        // An observation refreshes only the same public document. It cannot
        // become a second navigation lane or promote an ancillary response.
        const completedGesture = expectedGesture ? browser.currentGestureCompletion?.(snapshot, now()) : undefined;
        const gestureMatched = Boolean(expectedGesture && completedGesture && completedGesture.sourceUrl === expectedGesture.pageUrl &&
          completedGesture.href === expectedGesture.href && completedGesture.text === expectedGesture.text && completedGesture.label === expectedGesture.label &&
          completedGesture.targetUrl === expectedGesture.targetUrl && completedGesture.finalUrl === snapshot.url &&
          canonical(completedGesture.redirects) === canonical(expectedGesture.redirects) &&
          completedGesture.observedAt <= now() && now() - completedGesture.observedAt <= 5000 &&
          snapshot.navigationStatus === 200 && !snapshot.accessRequirementObserved && !snapshot.nativeFirstFatal);
        if (expectedGesture && !gestureMatched) throw fail('FRAMEWORK_INSPECTION_CONTEXT_CHANGED');
        const expectedOriginal = gestureMatched ? snapshot.url : ['observe','click'].includes(action) && previousContext?.currentUrl === url ? previousContext.originalUrl : url;
        let originalUrl = expectedOriginal;
        let capability = browser.currentMainDocumentContinuity?.(snapshot, originalUrl, now());
        if (!capability && action === 'open' && path.includes(snapshot.url)) {
          originalUrl = snapshot.url; capability = browser.currentMainDocumentContinuity?.(snapshot, originalUrl, now());
        }
        const projected = safeNativeMainDocumentContinuity(capability);
        const sameObservedDocument = !previousContext || action === 'open' || gestureMatched || projected?.documentBindingSha256 === previousContext.capability.documentBindingSha256;
        if (projected && sameObservedDocument && projected.originalUrlSha256 === hash(originalUrl) && projected.currentUrlSha256 === hash(snapshot.url) &&
            projected.observedAt <= now() && now() - projected.observedAt <= 5000 && snapshot.navigationStatus === 200) {
          currentNativeContext = { originalUrl, currentUrl: snapshot.url, capability };
          nativeContexts.set(snapshot, currentNativeContext); step.nativeMainDocumentContinuity = projected;
        } else currentNativeContext = undefined;
        if (gestureMatched && (!projected || projected.documentBindingSha256 !== completedGesture.documentBindingSha256))
          throw fail('FRAMEWORK_INSPECTION_CONTEXT_CHANGED');
        if (['observe','click'].includes(action) && new URL(snapshot.url).href !== new URL(url).href &&
            !gestureMatched && !(previousContext && nativeContextMatches(snapshot, previousContext.originalUrl, previousContext.capability.documentBindingSha256)))
          throw fail('FRAMEWORK_INSPECTION_CONTEXT_CHANGED');
        step.contextUrlSha256 = hash(snapshot.url);
        if (Number.isInteger(snapshot.navigationStatus)) step.navigationStatus = snapshot.navigationStatus;
        step.diagnostic = numericMetrics(snapshot.officialSourceDiagnostic) ?? {};
        const stage = snapshot.officialSourceDiagnostic?.stage;
        if (/^[A-Z_0-9]{1,80}$/u.test(stage ?? '')) step.diagnostic.stage = stage;
        const readiness = {};
        if (typeof snapshot.loading === 'boolean') readiness.loading = snapshot.loading;
        if (Number.isInteger(snapshot.pendingRequestCount) && snapshot.pendingRequestCount >= 0 && snapshot.pendingRequestCount <= 2048)
          readiness.pendingRequestCount = snapshot.pendingRequestCount;
        for (const field of ['rawOfficialCaptured', 'currentOfficialDocument', 'renderedHeadingsPresent', 'renderedAddressesPresent', 'renderedLinksPresent'])
          if (typeof snapshot.officialSourceDiagnostic?.[field] === 'boolean') readiness[field] = snapshot.officialSourceDiagnostic[field];
        if (['loading', 'interactive', 'complete'].includes(snapshot.readyState)) readiness.readyState = snapshot.readyState;
        if (Object.keys(readiness).length) step.readiness = readiness;
        if (['open', 'observe'].includes(action) && currentNativeContext && snapshot.navigationStatus === 200 &&
            snapshot.accessRequirementObserved === false && !snapshot.nativeFirstFatal) {
          const readability = safeInspectionReadability([step.readability]);
          if (readability && readability[0].failedPredicates.length === 0)
            lastPublicRoutingRead = { step, lastAction: action, readability, observedAt: projected.observedAt };
        }
        return snapshot;
      } catch (error) {
        step.error = inspectionErrorCode(error);
        try {
          const native = projectNativeRouterFailure(error?.details?.browserDiagnostics?.nativeFirstFatal);
          if (native) step.nativeRouterFailure = native;
        } catch { /* Diagnostic access cannot replace the primary failure. */ }
        const diagnostic = closedFilterDiagnostics(error);
        if (diagnostic) step.filterDiagnostic = diagnostic;
        try {
          const delegation = safeTeeItUpDelegationDiagnostic(error?.details?.browserDiagnostics?.teeItUpDelegation);
          if (delegation) step.teeItUpDelegation = delegation;
        } catch { /* Diagnostic access cannot replace the primary failure. */ }
        try {
          const adapterRead = safeFixedAdapterReadDiagnostic(error?.details?.browserDiagnostics?.adapterRead);
          if (adapterRead) step.adapterRead = adapterRead;
        } catch { /* Diagnostic access cannot replace the primary failure. */ }
        try { Object.assign(step, safeFixedInspectionSourceDiagnostic(error?.details?.browserDiagnostics)); }
        catch { /* Diagnostic access cannot replace the primary failure. */ }
        throw error;
      }
      finally { step.elapsedMs = Math.max(0, now() - start); }
    };
    let snapshot = await request('open', job.request.identity.officialUrl), position = 0, publicEntryDisclosed = false, frameWaitUsed = false;
    for (;;) {
      const current = new URL(nativeContexts.get(snapshot)?.originalUrl ?? snapshot.url).href;
      // Fresh browser redirects may traverse only the remainder of the observed routing path.
      const landed = path.indexOf(current, position);
      if (landed < position) {
        const hops=position===0?freshNativeOfficialRedirects(snapshot,path[0],current):null;
        if(!hops){
          receipt.landingFailure = inspectionLandingDiagnostic(snapshot, path, position, nativeContexts.get(snapshot), frameWitness);
          const step = receipt.actions.at(-1);
          if (step) { step.error = 'FRAMEWORK_INSPECTION_LANDING_CHANGED'; step.landing = receipt.landingFailure; }
          throw fail('FRAMEWORK_INSPECTION_LANDING_CHANGED');
        }
        receipt.freshNativeOfficialRedirects=hops.map(h=>({fromUrlSha256:hash(h.fromUrl),toUrlSha256:hash(h.toUrl),status:h.status}));
        path[0]=current; position=0; receipt.freshPathSha256=hash(canonical(path));
      } else position = landed;
      const next = path[position + 1];
      const historyRoute = next === undefined ? undefined : nativeHistoryNavigations(report, publicUrl).find(row=>
        row.documentUrl===current&&row.finalUrl===next&&snapshot.url===next);
      const historyContext = nativeContexts.get(snapshot);
      const historyProof = historyRoute && historyContext && safeNativeMainDocumentContinuity(
        browser.currentMainDocumentContinuity?.(snapshot,current,now()));
      if(historyRoute&&historyProof&&snapshot.navigationStatus===200&&!snapshot.accessRequirementObserved&&!snapshot.nativeFirstFatal&&
          historyProof.originalUrlSha256===hash(current)&&historyProof.currentUrlSha256===hash(next)&&
          historyProof.documentBindingSha256===historyContext.capability.documentBindingSha256&&historyProof.observedAt<=now()&&now()-historyProof.observedAt<=5000){
        // Re-earn the route in this independent browser, then reopen its exact
        // observed URL. A historical report alone never admits a new URL.
        snapshot=await request('open',next,'NATIVE_DOCUMENT_HISTORY_ROUTE');position++;continue;
      }
      const gesture = next === undefined ? undefined : nativeGestureNavigations(report, publicUrl).find(row =>
        row.pageUrl === snapshot.url && row.targetUrl === next && row.href === snapshot.url + '#');
      const matchingGestureControls = gesture ? (snapshot.controls ?? []).filter(row => row.kind === 'link' && row.href === gesture.href &&
        row.name?.replace(/\s+/gu,' ').trim() === gesture.text && row.label?.replace(/\s+/gu,' ').trim() === gesture.label &&
        typeof row.target === 'string' && /^[a-f0-9-]{36}$/u.test(row.target)) : [];
      const freshLinks = new Set([
        ...(snapshot.controls ?? []).filter(row => ['link','public-document-link'].includes(row.kind)).map(row => row.href),
        ...(snapshot.frames ?? []).filter(row => row.source === 'OFFICIAL_IFRAME_SRC' ||
          frameWitness && row.source === 'FIXED_INSPECTION_FRAME_SRC' && row.url === frameWitness.frameUrl &&
          snapshot.url === frameWitness.parentUrl && next === row.url).map(row => row.url),
        ...(matchingGestureControls.length === 1 ? [gesture.targetUrl] : []),
      ].filter(publicUrl).map(value => new URL(value).href));
      const requiredFixedFrame = Boolean(frameWitness && next === frameWitness.frameUrl && snapshot.url === frameWitness.parentUrl);
      const finalFrameOpen = frameWitness && path.at(-1) === frameWitness.frameUrl && position < path.length - 1 ? 1 : 0;
      const freshFixedFrameEdge = freshFixedInspectionFrameEdge(snapshot, frameWitness, next);
      const missingLink = next !== undefined && (requiredFixedFrame ? !freshFixedFrameEdge : !freshLinks.has(next));
      const disclosures = (snapshot.controls ?? []).filter(control => control.kind === 'public-entry-disclosure' &&
        typeof control.target === 'string' && /^[a-f0-9-]{36}$/u.test(control.target));
      if (missingLink && !publicEntryDisclosed && disclosures.length === 1 &&
          receipt.actions.length + Math.max(0,path.length-position-2) + finalFrameOpen + 2 + (earlyCpsContext && current !== recipe.source.bookingUrl ? 1 : 0) <= INSPECTION_ACTION_LIMIT) {
        publicEntryDisclosed = true;
        snapshot = await request('click', snapshot.url, 'PUBLIC_ENTRY_DISCLOSURE', disclosures[0].target); continue;
      }
      const diagnostic = snapshot.officialSourceDiagnostic;
      const exactNextPresent = next !== undefined && !missingLink;
      const storedContext = nativeContexts.get(snapshot);
      const terminalProof = position === path.length - 1 && storedContext?.originalUrl === path[position]
        ? safeNativeMainDocumentContinuity(browser.currentMainDocumentContinuity?.(snapshot, storedContext.originalUrl, now())) : undefined;
      const completedNativeTerminal = Boolean(terminalProof && snapshot.navigationStatus === 200 &&
        terminalProof.originalUrlSha256 === hash(storedContext.originalUrl) && terminalProof.currentUrlSha256 === hash(snapshot.url) &&
        terminalProof.documentBindingSha256 === storedContext.capability.documentBindingSha256 &&
        terminalProof.observedAt <= now() && now() - terminalProof.observedAt <= 5000);
      // A modal may hide background headings once its exact fresh frame exists.
      // At the final source, retained root metadata is not the provider document;
      // only its current private completed-main-read capability can replace this wait.
      const incompleteOfficial = incompleteInspectionOfficial(snapshot, completedNativeTerminal, freshFixedFrameEdge, exactNextPresent);
      // loading includes ancillary scripts/styles. It is not document readiness
      // once the required current official facts or the exact next link exist.
      const completeOfficial = diagnostic?.rawOfficialCaptured === true && diagnostic.currentOfficialDocument === true &&
        diagnostic.renderedAddressesPresent === true && diagnostic.renderedLinksPresent === true;
      const unsettledRequiredSource = snapshot.loading === true && !completeOfficial && !exactNextPresent && !completedNativeTerminal;
      const reason = incompleteOfficial ? 'OFFICIAL_RENDERING_INCOMPLETE' : unsettledRequiredSource ? 'PUBLIC_READS_PENDING' :
        missingLink ? 'FRESH_LINK_MISSING' : undefined;
      // Reserve all remaining path opens plus the one inspection. Observations
      // spend the existing six-action budget and original90s clock; no reset.
      const reserved = Math.max(0, path.length - position - 2) + finalFrameOpen + 1 +
        (earlyCpsContext && current !== recipe.source.bookingUrl ? 1 : 0);
      if (reason && requiredFixedFrame && frameWaitUsed) throw fail('FRAMEWORK_INSPECTION_PATH_STALE');
      if (reason && receipt.actions.length + reserved < INSPECTION_ACTION_LIMIT) {
        if (requiredFixedFrame) {
          frameWaitUsed = true;
          const waitMs = Math.min(8000, Math.max(0, deadline - now() - 1));
          if (waitMs < 1) throw fail('FRAMEWORK_INSPECTION_DEADLINE');
          await waitForFrame(waitMs, undefined, { signal: inspectionSignal }); check();
          receipt.fixedFrameWaitMs = waitMs;
        }
        snapshot = await request('observe', current, reason); continue;
      }
      if (unsettledRequiredSource) throw fail('FRAMEWORK_INSPECTION_SOURCE_NOT_SETTLED');
      if (missingLink) throw fail('FRAMEWORK_INSPECTION_PATH_STALE');
      if (position === path.length - 1) break;
      // Inspect an admitted final source from its current public parent. This
      // retains the fixed official-document witness; it grants no availability proof.
      // A fixed frame tag grants only its one fresh revalidated OPEN token;
      // it does not itself admit inspect_adapter on the provider URL.
      if (position + 1 === path.length - 1 && !gesture && !requiredFixedFrame) break;
      snapshot = gesture ? await request('click', snapshot.url, 'NATIVE_GESTURE_SOURCE_OPEN', matchingGestureControls[0].target, gesture)
        : await request('open', next);
      position++;
    }
    // Only after the unchanged fresh path/last-link check may an exact reviewed
    // CPS source choose its genuine booking document before the first probe.
    if (earlyCpsContext && !contextMatches(snapshot, recipe.source.bookingUrl)) {
      if (receipt.actions.length + 2 > INSPECTION_ACTION_LIMIT) throw fail('FRAMEWORK_INSPECTION_ACTION_LIMIT');
      const started = now();
      receipt.earlyCpsSourceContext = { exactObservedSource: true, parentContextUrlSha256: hash(snapshot.url),
        bookingUrlSha256: hash(recipe.source.bookingUrl), startedOffsetMs: Math.max(0, started - startedAt), completed: false };
      try {
        snapshot = await request('open', recipe.source.bookingUrl);
        if (!contextMatches(snapshot, recipe.source.bookingUrl) || snapshot.navigationStatus !== 200)
          throw fail('FRAMEWORK_INSPECTION_SOURCE_CONTEXT_CHANGED');
        receipt.earlyCpsSourceContext.completed = true;
      } finally { receipt.earlyCpsSourceContext.elapsedMs = Math.max(0, now() - started); }
    }
    const acuitySource = currentAcuityInspectionRedirect(snapshot, recipe.source.bookingUrl, nativeContexts.get(snapshot), browser, now());
    if (acuitySource) {
      if (receipt.actions.length + 2 > INSPECTION_ACTION_LIMIT) throw fail('FRAMEWORK_INSPECTION_ACTION_LIMIT');
      const originalSource = recipe.source.bookingUrl;
      snapshot = await request('open', acuitySource);
      if (snapshot.url !== acuitySource || snapshot.navigationStatus !== 200 || !nativeContextMatches(snapshot, acuitySource))
        throw fail('FRAMEWORK_INSPECTION_SOURCE_CONTEXT_CHANGED');
      recipe = { ...recipe, source: { ...recipe.source, bookingUrl: acuitySource } };
      receipt.canonicalAcuityRedirect = { originalSourceSha256: hash(originalSource), canonicalSourceSha256: hash(acuitySource), independentlyReopened: true };
    }
    const inspectedFrom = nativeContexts.get(snapshot);
    let inspected = await request('inspect_adapter', recipe.source.bookingUrl);
    if (new URL(inspected.url).href !== new URL(snapshot.url).href &&
        !(inspectedFrom && nativeContextMatches(inspected, inspectedFrom.originalUrl, inspectedFrom.capability.documentBindingSha256))) throw fail('FRAMEWORK_INSPECTION_CONTEXT_CHANGED');
    if (!inspected.adapter || typeof inspected.adapter !== 'object' || Array.isArray(inspected.adapter) ||
        typeof inspected.adapter.family !== 'string') throw fail('FRAMEWORK_INSPECTION_METADATA_INVALID');
    if (earlyCpsContext && inspected.adapter.family !== 'CPS') throw fail('FRAMEWORK_INSPECTION_METADATA_CONFLICT');
    if (acuitySource && inspected.adapter.family !== 'ACUITY') throw fail('FRAMEWORK_INSPECTION_METADATA_CONFLICT');

    let actualRecipe = { ...recipe,
      source: { ...recipe.source, ...(sourceOnly ? { providerFamily: inspected.adapter.family } : {}) }, adapter: inspected.adapter };
    // Only the exact private current inspection can adopt a fresh published
    // CPS entry. This is not URL-prefix equivalence or a new navigation grant.
    if (inspected.adapter.family === 'CPS' && inspected.adapter.officialEntryProof) {
      const current = worker.createDiscoveryAdapterObservation(job, recipe.source.bookingUrl, inspected.adapter, inspected.url,
        nativeContexts.get(inspected)?.capability, browser);
      actualRecipe = worker.bindDiscoveryRecipeIdentity(actualRecipe, job, current, inspected.url);
      if (canonical(actualRecipe.adapter) !== canonical(inspected.adapter) ||
          actualRecipe.source.bookingUrl !== inspected.adapter.officialEntryProof.bookingUrl)
        throw fail('FRAMEWORK_INSPECTION_PROOF_NOT_BOUND');
      receipt.adoptedSourceSha256 = hash(actualRecipe.source.bookingUrl);
    }
    const validation = await worker.validateDiscoveryRecipe({ cwd, recipe: actualRecipe, signal: inspectionSignal }); check();
    if (validation.valid !== true) throw fail('FRAMEWORK_INSPECTION_METADATA_INVALID');
    // CPS postal proof adoption requires the actual current booking document.
    // Never relabel the official-parent context or reuse its inspected proof.
    if (inspected.adapter.family === 'CPS' && inspected.adapter.officialPostalConflictProof &&
        !contextMatches(inspected, recipe.source.bookingUrl)) {
      if (receipt.actions.length + 2 > INSPECTION_ACTION_LIMIT) throw fail('FRAMEWORK_INSPECTION_ACTION_LIMIT');
      const started = now();
      receipt.sourceContextReinspection = { required: true, firstResultDiscarded: true,
        originalContextUrlSha256: hash(inspected.url), bookingUrlSha256: hash(recipe.source.bookingUrl),
        startedOffsetMs: Math.max(0, started - startedAt), completed: false };
      try {
        snapshot = await request('open', recipe.source.bookingUrl);
        if (!contextMatches(snapshot, recipe.source.bookingUrl) || snapshot.navigationStatus !== 200)
          throw fail('FRAMEWORK_INSPECTION_SOURCE_CONTEXT_CHANGED');
        inspected = await request('inspect_adapter', recipe.source.bookingUrl);
        if (!contextMatches(inspected, recipe.source.bookingUrl) || inspected.navigationStatus !== 200)
          throw fail('FRAMEWORK_INSPECTION_SOURCE_CONTEXT_CHANGED');
        if (!inspected.adapter || typeof inspected.adapter !== 'object' || Array.isArray(inspected.adapter) || inspected.adapter.family !== 'CPS' ||
            false)
          throw fail('FRAMEWORK_INSPECTION_METADATA_CONFLICT');
        if (inspected.adapter.officialPostalConflictProof?.kind !== 'CANONICAL_PHONE_POSTAL_CONFLICT')
          throw fail('FRAMEWORK_INSPECTION_PROOF_NOT_BOUND');
        actualRecipe = { ...recipe,
          source: { ...recipe.source, ...(sourceOnly ? { providerFamily: inspected.adapter.family } : {}) }, adapter: inspected.adapter };
        const secondValidation = await worker.validateDiscoveryRecipe({ cwd, recipe: actualRecipe, signal: inspectionSignal }); check();
        if (secondValidation.valid !== true) throw fail('FRAMEWORK_INSPECTION_METADATA_INVALID');
        receipt.sourceContextReinspection.completed = true;
      } finally { receipt.sourceContextReinspection.elapsedMs = Math.max(0, now() - started); }
    }
    const observation = worker.createDiscoveryAdapterObservation(job, recipe.source.bookingUrl, inspected.adapter, inspected.url, nativeContexts.get(inspected)?.capability, browser);
    const bound = worker.bindDiscoveryRecipeIdentity(actualRecipe, job, observation, inspected.url);
    if (!observation || canonical(bound.adapter) !== canonical(inspected.adapter)) throw fail('FRAMEWORK_INSPECTION_PROOF_NOT_BOUND');
    const sourceEvidence = worker.inspectedAdapterSourceEvidence(bound, job, observation, true, inspected.url);
    if (!sourceEvidence || sourceEvidence.officialUrl !== job.request.identity.officialUrl ||
        sourceEvidence.observedBookingUrl !== bound.source.bookingUrl) throw fail('FRAMEWORK_INSPECTION_OBSERVATION_INVALID');
    receipt.actualAdapterSha256 = hash(canonical(inspected.adapter)); receipt.observationBound = true;
    receipt.controllerFilledKnownMetadata = sourceOnly;
    receipt.metadataAuthority = 'FRESH_FIXED_INSPECTOR';
    result = { recipe: bound, sourceEvidence };
  } catch (error) { primary = error; }
  finally {
    if (browser) {
      const closeStartedAt = now();
      try { await browser.close(); receipt.browserClosed = true; browserClosedClean = true; }
      catch (error) { receipt.cleanupError = inspectionErrorCode(error); primary ??= fail('FRAMEWORK_INSPECTION_CLOSE_FAILED'); }
      receipt.cleanupElapsedMs = Math.max(0, now() - closeStartedAt);
    }
    receipt.elapsedMs = Math.max(0, now() - startedAt);
    if (!primary) { try { check(); } catch (error) { primary = error; } }
    receipt.outcome = primary ? 'FAILED' : 'INSPECTED';
    if (primary) receipt.error = inspectionErrorCode(primary);
    try { onReceipt(receipt); } catch { primary ??= fail('FRAMEWORK_INSPECTION_RECEIPT_FAILED'); }
  }
  if (primary) {
    primary.inspectionReceipt = receipt;
    const failedAction = receipt.actions.at(-1);
    if (['FRAMEWORK_INSPECTION_PATH_STALE', 'FRAMEWORK_INSPECTION_SOURCE_NOT_SETTLED'].includes(primary.code) &&
        browserClosedClean && !receipt.cleanupError && lastPublicRoutingRead?.step === failedAction && !failedAction.error &&
        lastPublicRoutingRead.observedAt <= now() && now() - lastPublicRoutingRead.observedAt <= 5000) {
      publicRoutingRecoveries.set(primary, { job, jobId: job.id, leaseTokenSha256: hash(job.leaseToken), attempt: job.attempts, requestSha256: hash(canonical(job.request)),
        sourceFingerprint: job.sourceFingerprint, firstPickedUpAt: job.firstPickedUpAt, deadlineAt: job.deadlineAt, startedAt,
        observedAt: lastPublicRoutingRead.observedAt, code: primary.code, lastAction: lastPublicRoutingRead.lastAction, readability: lastPublicRoutingRead.readability });
    }
    const readability = failedAction?.readability?.failedPredicates?.length ? safeInspectionReadability(receipt.actions.map(row => row.readability).filter(Boolean)) : undefined;
    const landing = safeInspectionLandingDiagnostic(failedAction?.landing);
    if (primary && typeof primary === 'object' && failedAction?.error &&
        (readability || landing || failedAction.nativeRouterFailure || failedAction.action === 'inspect_adapter' &&
          (failedAction.teeItUpDelegation || failedAction.adapterRead || safeFixedInspectionSourceDiagnostic(failedAction)))) {
      try {
        inspectionFailures.set(primary, { job, attempt: job.attempts, requestSha256: hash(canonical(job.request)), sourceFingerprint: job.sourceFingerprint,
          firstPickedUpAt: job.firstPickedUpAt, deadlineAt: job.deadlineAt, startedAt,
          teeItUpDelegation: safeTeeItUpDelegationDiagnostic(failedAction.teeItUpDelegation),
          adapterRead: safeFixedAdapterReadDiagnostic(failedAction.adapterRead), ...(readability ? { readability } : {}), ...(landing ? { landing } : {}),
          nativeRouterFailure: safeNativeRouterFailure(failedAction.nativeRouterFailure),
          ...(safeFixedInspectionSourceDiagnostic(failedAction) ?? {}) });
      } catch { /* Optional diagnostics cannot replace the primary failure. */ }
    }
    throw primary;
  }
  return { ...result, receipt };
}
