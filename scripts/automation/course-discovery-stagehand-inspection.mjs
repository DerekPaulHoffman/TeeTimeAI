// Source-routing inspection only. No model, uploaded recipe, or cached proof is admitted here.
import { discoveryError } from "./course-discovery-client.mjs";
import { STAGEHAND_SOURCE_MODE, canonicalStagehandData as canonical, stagehandDataHash as hash,
  publicStagehandSourceUrl as publicUrl, validateStagehandSourceProposal as validateAdapterSourceProposal,
  validateStagehandSourceReport } from "./course-discovery-stagehand-source.mjs";
import { observedBookingSourceCandidates, nativeLinkSource, corroboratedNativeLink } from "./stagehand/source-provenance.mjs";
const fail = code => discoveryError(code), HYBRID_SOURCE_DISCOVERY = STAGEHAND_SOURCE_MODE;
const INSPECTION_ACTION_LIMIT = 6;
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
    for (const item of (row.links ?? []).slice(0, 512)) link(row.pageUrl, item.href);
  for (const row of (report.frameLedger ?? []).slice(0, 512))
    for (const frame of (row.frames ?? []).slice(0, 32)) link(row.pageUrl, frame.src);
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
const inspectionCodes = new Set(["FRAMEWORK_HYBRID_REPORT_INVALID","FRAMEWORK_SOURCE_PROPOSAL_WITH_RECIPE","FRAMEWORK_INSPECTION_CANCELLED","FRAMEWORK_INSPECTION_DEADLINE","FRAMEWORK_INSPECTION_ENGINE_INVALID","FRAMEWORK_HYBRID_SOURCE_NOT_ELIGIBLE","FRAMEWORK_INSPECTION_SCOPE_INVALID","FRAMEWORK_INSPECTION_ACTION_LIMIT","FRAMEWORK_INSPECTION_TRANSPORT_CHANGED","FRAMEWORK_INSPECTION_SOURCE_UNREADABLE","FRAMEWORK_INSPECTION_CONTEXT_CHANGED","FRAMEWORK_INSPECTION_LANDING_CHANGED","FRAMEWORK_INSPECTION_SOURCE_NOT_SETTLED","FRAMEWORK_INSPECTION_PATH_STALE","FRAMEWORK_INSPECTION_SOURCE_CONTEXT_CHANGED","FRAMEWORK_INSPECTION_METADATA_INVALID","FRAMEWORK_INSPECTION_METADATA_CONFLICT","FRAMEWORK_INSPECTION_PROOF_NOT_BOUND","FRAMEWORK_INSPECTION_OBSERVATION_INVALID","FRAMEWORK_INSPECTION_CLOSE_FAILED","FRAMEWORK_INSPECTION_RECEIPT_FAILED"]);
const inspectionErrorCode = error => inspectionCodes.has(error?.code) ? error.code : "STAGEHAND_FIXED_INSPECTION_FAILED";
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
  const deadline = Math.min(Date.parse(job.deadlineAt), Date.parse(workDeadlineAt), startedAt + 90_000);
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
  let browser, primary, result;
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
    const earlyCpsContext = mode === HYBRID_SOURCE_DISCOVERY && sourceOnly && isReviewedCpsSourceEntry(recipe.source.bookingUrl);
    receipt.pathSha256 = hash(canonical(path)); receipt.pathLength = path.length;
    const environment = client.helperEnvironment('discovery', job);
    if (environment.COURSE_DISCOVERY_BROWSER_TRANSPORT !== 'NATIVE_CHROME' ||
        environment.COURSE_DISCOVERY_JOB_ID !== job.id || environment.COURSE_DISCOVERY_JOB_KIND !== 'discovery' ||
        environment.COURSE_DISCOVERY_LEASE_TOKEN !== job.leaseToken) throw fail('FRAMEWORK_INSPECTION_SCOPE_INVALID');
    const inspectionSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, deadline - now()))]);
    browser = await worker.createDiscoveryBrowser({ cwd, deadlineAt: new Date(deadline).toISOString(),
      initialUrls: [job.request.identity.officialUrl], timeZone: job.request.input.timeZone,
      requestedInput: job.request.input,
      ...(job.request.trustedContext!==undefined?{trustedContext:job.request.trustedContext}:{}),
      venueName: job.request.identity.name, venueAddress: job.request.identity.address,
      venueOfficialUrl: job.request.identity.officialUrl, helperEnvironment: environment, signal: inspectionSignal });
    const request = async (action, url, observeReason) => {
      check();
      if (receipt.actions.length >= INSPECTION_ACTION_LIMIT) throw fail('FRAMEWORK_INSPECTION_ACTION_LIMIT');
      const start = now(), step = { action, urlSha256: hash(url), startedOffsetMs: Math.max(0, start - startedAt) };
      if (observeReason) step.observeReason = observeReason;
      receipt.actions.push(step);
      try {
        const snapshot = await browser.request(action === 'observe' ? { action } : { action, url }); check();
        if (snapshot?.browserTransport !== 'NATIVE_CHROME') throw fail('FRAMEWORK_INSPECTION_TRANSPORT_CHANGED');
        if (!publicUrl(snapshot.url) || snapshot.accessRequirementObserved || snapshot.nativeFirstFatal ||
            action === 'open' && !Number.isInteger(snapshot.navigationStatus) ||
            snapshot.navigationStatus !== undefined && !(snapshot.navigationStatus >= 200 && snapshot.navigationStatus < 400))
          throw fail('FRAMEWORK_INSPECTION_SOURCE_UNREADABLE');
        // An observation refreshes only the same public document. It cannot
        // become a second navigation lane or promote an ancillary response.
        if (action === 'observe' && new URL(snapshot.url).href !== new URL(url).href)
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
        return snapshot;
      } catch (error) { step.error = inspectionErrorCode(error); const diagnostic=closedFilterDiagnostics(error); if(diagnostic)step.filterDiagnostic=diagnostic; throw error; }
      finally { step.elapsedMs = Math.max(0, now() - start); }
    };
    let snapshot = await request('open', job.request.identity.officialUrl), position = 0;
    for (;;) {
      const current = new URL(snapshot.url).href;
      // Fresh browser redirects may traverse only the remainder of the observed routing path.
      const landed = path.indexOf(current, position);
      if (landed < position) {
        const hops=position===0?freshNativeOfficialRedirects(snapshot,path[0],current):null;
        if(!hops)throw fail('FRAMEWORK_INSPECTION_LANDING_CHANGED');
        receipt.freshNativeOfficialRedirects=hops.map(h=>({fromUrlSha256:hash(h.fromUrl),toUrlSha256:hash(h.toUrl),status:h.status}));
        path[0]=current; position=0; receipt.freshPathSha256=hash(canonical(path));
      } else position = landed;
      const next = path[position + 1];
      const freshLinks = new Set([
        ...(snapshot.controls ?? []).filter(row => row.kind === 'link').map(row => row.href),
        ...(snapshot.frames ?? []).filter(row => row.source === 'OFFICIAL_IFRAME_SRC').map(row => row.url),
      ].filter(publicUrl).map(value => new URL(value).href));
      const missingLink = next !== undefined && !freshLinks.has(next);
      const diagnostic = snapshot.officialSourceDiagnostic;
      const incompleteOfficial = diagnostic?.rawOfficialCaptured === true &&
        (diagnostic.currentOfficialDocument === false ||
          diagnostic.renderedHeadingsPresent === false && diagnostic.renderedAddressesPresent === false);
      // loading includes ancillary scripts/styles. It is not document readiness
      // once the required current official facts or the exact next link exist.
      const completeOfficial = diagnostic?.rawOfficialCaptured === true && diagnostic.currentOfficialDocument === true &&
        diagnostic.renderedAddressesPresent === true && diagnostic.renderedLinksPresent === true;
      const unsettledRequiredSource = snapshot.loading === true && !completeOfficial && !(next !== undefined && !missingLink);
      const reason = incompleteOfficial ? 'OFFICIAL_RENDERING_INCOMPLETE' : unsettledRequiredSource ? 'PUBLIC_READS_PENDING' :
        missingLink ? 'FRESH_LINK_MISSING' : undefined;
      // Reserve all remaining path opens plus the one inspection. Observations
      // spend the existing six-action budget and original90s clock; no reset.
      const reserved = Math.max(0, path.length - position - 2) + 1 +
        (earlyCpsContext && current !== recipe.source.bookingUrl ? 1 : 0);
      if (reason && receipt.actions.length + reserved < INSPECTION_ACTION_LIMIT) {
        snapshot = await request('observe', current, reason); continue;
      }
      if (unsettledRequiredSource) throw fail('FRAMEWORK_INSPECTION_SOURCE_NOT_SETTLED');
      if (missingLink) throw fail('FRAMEWORK_INSPECTION_PATH_STALE');
      if (position === path.length - 1) break;
      // Inspect an admitted final source from its current public parent. This
      // retains the fixed official-document witness; it grants no availability proof.
      if (position + 1 === path.length - 1) break;
      snapshot = await request('open', next); position++;
    }
    // Only after the unchanged fresh path/last-link check may an exact reviewed
    // CPS source choose its genuine booking document before the first probe.
    if (earlyCpsContext && snapshot.url !== recipe.source.bookingUrl) {
      if (receipt.actions.length + 2 > INSPECTION_ACTION_LIMIT) throw fail('FRAMEWORK_INSPECTION_ACTION_LIMIT');
      const started = now();
      receipt.earlyCpsSourceContext = { exactObservedSource: true, parentContextUrlSha256: hash(snapshot.url),
        bookingUrlSha256: hash(recipe.source.bookingUrl), startedOffsetMs: Math.max(0, started - startedAt), completed: false };
      try {
        snapshot = await request('open', recipe.source.bookingUrl);
        if (snapshot.url !== recipe.source.bookingUrl || snapshot.navigationStatus !== 200)
          throw fail('FRAMEWORK_INSPECTION_SOURCE_CONTEXT_CHANGED');
        receipt.earlyCpsSourceContext.completed = true;
      } finally { receipt.earlyCpsSourceContext.elapsedMs = Math.max(0, now() - started); }
    }
    let inspected = await request('inspect_adapter', recipe.source.bookingUrl);
    if (new URL(inspected.url).href !== new URL(snapshot.url).href) throw fail('FRAMEWORK_INSPECTION_CONTEXT_CHANGED');
    if (!inspected.adapter || typeof inspected.adapter !== 'object' || Array.isArray(inspected.adapter) ||
        typeof inspected.adapter.family !== 'string') throw fail('FRAMEWORK_INSPECTION_METADATA_INVALID');
    if (earlyCpsContext && inspected.adapter.family !== 'CPS') throw fail('FRAMEWORK_INSPECTION_METADATA_CONFLICT');

    let actualRecipe = { ...recipe,
      source: { ...recipe.source, ...(sourceOnly ? { providerFamily: inspected.adapter.family } : {}) }, adapter: inspected.adapter };
    const validation = await worker.validateDiscoveryRecipe({ cwd, recipe: actualRecipe, signal: inspectionSignal }); check();
    if (validation.valid !== true) throw fail('FRAMEWORK_INSPECTION_METADATA_INVALID');
    // CPS postal proof adoption requires the actual current booking document.
    // Never relabel the official-parent context or reuse its inspected proof.
    if (inspected.adapter.family === 'CPS' && inspected.adapter.officialPostalConflictProof &&
        new URL(inspected.url).href !== recipe.source.bookingUrl) {
      if (receipt.actions.length + 2 > INSPECTION_ACTION_LIMIT) throw fail('FRAMEWORK_INSPECTION_ACTION_LIMIT');
      const started = now();
      receipt.sourceContextReinspection = { required: true, firstResultDiscarded: true,
        originalContextUrlSha256: hash(inspected.url), bookingUrlSha256: hash(recipe.source.bookingUrl),
        startedOffsetMs: Math.max(0, started - startedAt), completed: false };
      try {
        snapshot = await request('open', recipe.source.bookingUrl);
        if (snapshot.url !== recipe.source.bookingUrl || snapshot.navigationStatus !== 200)
          throw fail('FRAMEWORK_INSPECTION_SOURCE_CONTEXT_CHANGED');
        inspected = await request('inspect_adapter', recipe.source.bookingUrl);
        if (inspected.url !== recipe.source.bookingUrl || inspected.navigationStatus !== 200)
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
    const observation = worker.createDiscoveryAdapterObservation(job, recipe.source.bookingUrl, inspected.adapter, inspected.url);
    const bound = worker.bindDiscoveryRecipeIdentity(actualRecipe, job, observation, inspected.url);
    if (!observation || canonical(bound.adapter) !== canonical(inspected.adapter)) throw fail('FRAMEWORK_INSPECTION_PROOF_NOT_BOUND');
    const sourceEvidence = worker.inspectedAdapterSourceEvidence(bound, job, observation, true, inspected.url);
    if (!sourceEvidence || sourceEvidence.officialUrl !== job.request.identity.officialUrl ||
        sourceEvidence.observedBookingUrl !== recipe.source.bookingUrl) throw fail('FRAMEWORK_INSPECTION_OBSERVATION_INVALID');
    receipt.actualAdapterSha256 = hash(canonical(inspected.adapter)); receipt.observationBound = true;
    receipt.controllerFilledKnownMetadata = sourceOnly;
    receipt.metadataAuthority = 'FRESH_FIXED_INSPECTOR';
    result = { recipe: bound, sourceEvidence };
  } catch (error) { primary = error; }
  finally {
    if (browser) {
      const closeStartedAt = now();
      try { await browser.close(); receipt.browserClosed = true; }
      catch (error) { receipt.cleanupError = inspectionErrorCode(error); primary ??= fail('FRAMEWORK_INSPECTION_CLOSE_FAILED'); }
      receipt.cleanupElapsedMs = Math.max(0, now() - closeStartedAt);
    }
    receipt.elapsedMs = Math.max(0, now() - startedAt);
    if (!primary) { try { check(); } catch (error) { primary = error; } }
    receipt.outcome = primary ? 'FAILED' : 'INSPECTED';
    if (primary) receipt.error = inspectionErrorCode(primary);
    try { onReceipt(receipt); } catch { primary ??= fail('FRAMEWORK_INSPECTION_RECEIPT_FAILED'); }
  }
  if (primary) { primary.inspectionReceipt = receipt; throw primary; }
  return { ...result, receipt };
}
