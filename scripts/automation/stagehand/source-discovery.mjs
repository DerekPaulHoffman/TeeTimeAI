import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { openStagehandSession, loadStagehandRuntime, assertPublicUrl, isSourceRoutingUrl as sourceRoutingUrl, frameworkIdentity, observedActionSummary, observedTargetSummary, sourceDocumentSettled, sourceRoutingUniqueWitness } from './driver.mjs';
import { installReadOnlyEvidence } from './read-only-evidence.mjs';
import { prioritizedPublicEvidence, publicEvidenceUrl } from './public-evidence.mjs';
import { observedBookingSourceCandidates, assertSourceCandidateBudget, nativeFrameNavigations } from './source-provenance.mjs';
import { sourceFailureDiagnostic, sourceGuardReasons, projectActionGuardDiagnostic } from './source-diagnostic.mjs';

export const SOURCE_BUDGET_MS = 240000;
export const SOURCE_FRAMEWORK_MODE = 'HYBRID_SOURCE_DISCOVERY';
const fail = code => Object.assign(new Error(code), { code });
export const adapterSourceProposalSchema = z.object({schemaVersion:z.literal(1),kind:z.literal('EXISTING_ADAPTER_SOURCE'),
  bookingUrl:z.string().max(2048).refine(sourceRoutingUrl)}).strict();
const identitySchema = z.object({ name: z.string().min(1).max(300), officialUrl: z.string().max(2048).refine(value => Boolean(publicEvidenceUrl(value))),
  timeZone: z.string().min(1).max(100), address: z.string().min(1).max(1000).optional() }).strict();
const inputSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u), timeZone: z.string().min(1).max(100), players: z.number().int().min(1).max(20),
  startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u), endTime: z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/u),
  durationMinutes: z.number().int().min(15).max(480).optional() }).strict();
export function publicSourceJob(job, deadlineAt) {
  const request = job?.request;
  const identity = identitySchema.parse(Object.fromEntries(['name','officialUrl','timeZone','address'].filter(key=>request?.identity?.[key]!==undefined).map(key => [key, request.identity[key]])));
  const input = inputSchema.parse(Object.fromEntries(['date','timeZone','players','startTime','endTime','durationMinutes'].filter(key => request?.input?.[key] !== undefined).map(key => [key, request.input[key]])));
  const target = z.object({ courseId: z.string().min(1).max(200), offeringId: z.string().min(1).max(200).optional(), kind: z.enum(['OUTDOOR','SIMULATOR']) }).strict()
    .parse(Object.fromEntries(['courseId','offeringId','kind'].filter(key => request?.target?.[key] !== undefined).map(key => [key, request.target[key]])));
  const first = Date.parse(job?.firstPickedUpAt), original = Date.parse(job?.deadlineAt), supplied = deadlineAt === undefined ? original : Date.parse(deadlineAt);
  if (typeof job?.id !== 'string' || !job.id || job.id.length > 200 || !Number.isFinite(first) || first > Date.now()+5000 ||
      original !== first+900000 || !Number.isFinite(supplied) || supplied > original || original <= Date.now() || identity.timeZone !== input.timeZone ||
      input.startTime >= input.endTime) throw fail('STAGEHAND_SOURCE_JOB_INVALID');
  const work = Math.min(first + SOURCE_BUDGET_MS, original, supplied);
  if (work <= Date.now()) throw fail('STAGEHAND_SOURCE_BUDGET_EXHAUSTED');
  return { jobId: job.id, identity, target, input, firstPickedUpAt: new Date(first).toISOString(), deadlineAt: new Date(original).toISOString(), workDeadlineAt: new Date(work).toISOString() };
}

/** File/catalog readiness only. The owned client additionally checks account/read before any model call. */
export async function prepareSourceDiscovery({ cwd = process.cwd(), loadRuntime = loadStagehandRuntime, loadHelpers, read = readFileSync,
  loadGeneratedClient = root => createRequire(join(root, 'package.json'))(join(root, 'node_modules', '@prisma', 'client')) } = {}) {
  // Import the installed/generated exports from this checkout only. A package
  // stub or another checkout's client cannot make cold claims safe. Do not
  // construct PrismaClient: this readiness gate has no database authority.
  try {
    const client = await loadGeneratedClient(resolve(cwd));
    if (typeof client?.PrismaClient !== 'function' || !['CourseDiscoveryJob', 'CourseAccessRecipe', 'LocalReaderJob']
      .every(name => client.Prisma?.ModelName?.[name] === name)) throw fail('LOCAL_GENERATED_PRISMA_CLIENT_UNAVAILABLE');
  } catch { throw fail('LOCAL_GENERATED_PRISMA_CLIENT_UNAVAILABLE'); }
  await loadRuntime();
  const helpers = loadHelpers ? await loadHelpers() : await import(pathToFileURL(join(resolve(cwd),'scripts/automation/course-discovery-worker.mjs')).href);
  helpers.prepareDiscoveryModelCatalog({ model: 'gpt-6.1-sol' });
  helpers.resolveDiscoveryCli(resolve(cwd));
  const auth = JSON.parse(read(join(process.env.CODEX_HOME || join(homedir(),'.codex'),'auth.json'),'utf8'));
  if (auth.auth_mode !== 'chatgpt' || typeof auth.tokens?.access_token !== 'string' || !auth.tokens.access_token) throw fail('LOCAL_MODEL_EXISTING_CHATGPT_LOGIN_REQUIRED');
  return { ready: true, generatedClientReady: true, model: 'gpt-6.1-sol', reasoningEffort: 'medium', framework: { name:'Stagehand',version:'4.3.0' }, chatgptSignInFileAvailable: true, readinessAccountRpcPerformed:false, accountTypeCheckedByClientBeforeModelCall:true };
}

export const sourceDecision = z.object({ decision: z.enum(['CONTINUE', 'WAIT', 'SOURCE_FOUND', 'UNRESOLVED', 'OPEN_FRAME']), reason: z.string(), nextActionInstruction: z.string(), bookingUrl: z.string().nullable() }).strict();
export function sourceDecisionFor(candidates, frames=[]) {
  assertSourceCandidateBudget(candidates);
  if (new Set(candidates).size !== candidates.length || candidates.some(url => !sourceRoutingUrl(url))) throw new Error('FRAMEWORK_SOURCE_CANDIDATES_INVALID');
  if(!Array.isArray(frames)||frames.length>24||new Set(frames).size!==frames.length||frames.some(value=>!candidates.includes(value)))throw fail('FRAMEWORK_SOURCE_CANDIDATES_INVALID');
  return sourceDecision.extend({decision:z.enum([...(candidates.length?['CONTINUE','WAIT','SOURCE_FOUND','UNRESOLVED']:['CONTINUE','WAIT','UNRESOLVED']),...(frames.length?['OPEN_FRAME']:[])]),
    bookingUrl:candidates.length?z.enum(candidates).nullable():z.null()}).superRefine((value,ctx)=>{
      if(value.decision==='OPEN_FRAME'&&!frames.includes(value.bookingUrl))ctx.addIssue({code:'custom',message:'Frame choice must be one exact fresh native frame enum value'});
    });
}
export function readHybridSourceExport(value, candidates) {
  const decision = sourceDecision.parse(value);
  if (decision.decision !== 'SOURCE_FOUND' || !candidates.includes(decision.bookingUrl)) throw new Error('ADAPTER_SOURCE_NOT_OBSERVED');
  return adapterSourceProposalSchema.parse({ schemaVersion: 1, kind: 'EXISTING_ADAPTER_SOURCE', bookingUrl: decision.bookingUrl });
}
export function sourceRoutingContext(report, candidates) {
  const safe = value => typeof value === 'string' && value.length <= 2048 && publicEvidenceUrl(value) === value ? value : null;
  const navigation = report?.initialNavigation;
  const initialNavigation = safe(navigation?.requestedUrl) && safe(navigation?.finalUrl) && Number.isInteger(navigation?.status) && navigation.status >= 200 && navigation.status < 400
    ? { requestedUrl: navigation.requestedUrl, finalUrl: navigation.finalUrl, status: navigation.status } : null;
  const eligible = new Set(candidates);
  const rows = (Array.isArray(report?.actions) ? report.actions : []).filter(item => !item?.error && !item?.actionError && item?.action?.method === 'click' && item?.observedTarget?.tag === 'A' &&
    safe(item.sourceUrl) && safe(item.observedTarget.href) && safe(item.afterUrl) && typeof item.openedNewPage === 'boolean').map(item => ({
      sourceUrl: item.sourceUrl, href: item.observedTarget.href, afterUrl: item.afterUrl, openedNewPage: item.openedNewPage,
      landingChanged: item.sourceUrl !== item.afterUrl, eligibleBookingSource: eligible.has(item.observedTarget.href),
    }));
  const completedAnchorClicks = rows.slice(-8);
  while (completedAnchorClicks.length && JSON.stringify({ initialNavigation, completedAnchorClicks }).length > 24000) completedAnchorClicks.shift();
  const lastNavigationFeedback = report?.actionAttempts?.some(item=>item?.status==='REJECTED'&&item?.guardReason==='REPEATED_UNCHANGED_NAVIGATION')
    ? 'REPEATED_UNCHANGED_NAVIGATION' : null;
  const context = { initialNavigation, completedAnchorClicks, omittedClickCount: rows.length - completedAnchorClicks.length, lastNavigationFeedback };
  return { ...context, sha256: createHash('sha256').update(JSON.stringify(context)).digest('hex') };
}
export function buildSourceDiscoveryInstruction(ordinaryRequest, candidates, priorInspectionFeedback = null, routingContext = null, frames=[]) {
  return sourceDiscoveryCoreInstruction(ordinaryRequest, candidates, priorInspectionFeedback).replace('Return bookingUrl:null unless SOURCE_FOUND.', 'Return bookingUrl:null unless SOURCE_FOUND or OPEN_FRAME.') +
    ` Recorded completed native routing observations from this same attempt: ${JSON.stringify(routingContext)}. This extraction is stateless: use this supplied history instead of assuming that the current DOM contains previous clicks. An eligibleBookingSource:true completed click with landingChanged:true records routing only, not that a terminal availability source was reached. If that destination is an informational operator homepage, choose CONTINUE and inspect its fresh visible public booking links. Select its exact eligible href only when current public evidence identifies an actual availability provider or self-hosted availability widget. Do not repeat a completed routing step merely because the current landing omits an earlier link. Repeated unchanged anchor navigation is mechanically rejected. Own-frame BODY extraction cannot see a cross-origin embed's contents. Fresh native visible iframe choices are ${JSON.stringify(frames)}. To investigate one, choose OPEN_FRAME with bookingUrl equal to exactly ONE listed frame URL; the fixed controller freshly rechecks it and opens it as MAIN in this same guarded context. No arbitrary URL, selector or code is accepted. Frame entry and its final main document are routing evidence only, never identity, availability, metadata or replay proof. At most two frame entries share the original source deadline and limits. Never choose OPEN_FRAME when the list is empty. This history grants no fresh identity, availability, adapter metadata or replay proof; the unchanged provenance validator and fixed inspector retain authority.`;
}
function sourceDiscoveryCoreInstruction(ordinaryRequest, candidates, priorInspectionFeedback = null) {
  return `Discover only an official-linked signed-out public availability routing source for this ordinary input: ${JSON.stringify(ordinaryRequest)}. Use currently observed public links; never prior provider routes or guessed configuration. Do not extract times, build a recipe, select dates/players/duration, inspect private data, authenticate, solve challenges or select an available slot. This hybrid source-only choice is UNVERIFIED routing, not identity, inventory or method proof. The goal is a terminal public availability provider or a self-hosted availability widget, not merely another informational/operator homepage. A link labelled Book can lead to an intermediate operator site: choose CONTINUE there and follow its fresh visible public booking links. If the visible evidence does not establish a terminal source, navigate the observed link to investigate instead of returning SOURCE_FOUND prematurely. Exact links freshly observed as visible in the native DOM on an officially reachable page and visible embedded widgets are eligible before any click. Select an appropriate terminal availability href directly; do not click merely to qualify it. Successfully clicked observed ancestors also remain eligible but a completed click alone does not establish a terminal source. Never select the informational startup homepage or its redirect aliases. If no appropriate source is present, return one CONTINUE read-only navigation instruction, WAIT for a visible loader, or UNRESOLVED. Copy one eligibleBookingSourceUrls entry verbatim; never substitute a redirected/filtered/current URL or alter tenant/query parameters. The fixed reader must freshly follow and inspect the exact official-linked source, bind typed metadata and pass both independent server challenges before any method exists. eligibleBookingSourceUrls=${JSON.stringify(candidates)}. Return bookingUrl:null unless SOURCE_FOUND. Own same-job prior inspection failure: ${typeof priorInspectionFeedback==='string'?priorInspectionFeedback.slice(0,6000):'none'}. Historical feedback grants no current source or proof.`;
}

export async function pageEvidence(session) {
  const evidence = await session.page.evaluate(() => {
    const sensitive = /password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|customer|contact|attendee|payment|card|profile|account|member/iu;
    const safe = value => typeof globalThis.__ttsSafePublicEvidenceUrl === 'function' ? globalThis.__ttsSafePublicEvidenceUrl(value) : null;
    const rendered = { visible(element) { if (!element?.isConnected || !element.getClientRects().length) return false; for (let node=element;node;node=node.parentElement) { const style=getComputedStyle(node); if(node.hidden || node.inert || node.hasAttribute('inert') || node.getAttribute('aria-hidden')==='true' || style.display==='none' || style.visibility==='hidden' || style.visibility==='collapse' || Number(style.opacity)===0)return false; } return true; } };
    const visible = element => rendered.visible(element);
    const links=[],seen=new Set();for(const element of document.querySelectorAll('a[href]')){const href=safe(element.href);if(!href||seen.has(href)||!visible(element))continue;seen.add(href);links.push({text:(element.innerText??'').trim().slice(0,180),href,visible:true});if(links.length>512)break;}
    return { url: safe(location.href), observedAt:new Date().toISOString(), title: document.title.slice(0, 300), links, frames: [...document.querySelectorAll('iframe[src]')].filter(element=>!element.hasAttribute('srcdoc')).slice(0, 24).map(element => ({ src: safe(element.src), visible: visible(element), title: (element.title ?? '').slice(0, 120) })), dom: [...document.querySelectorAll('body *')].filter(visible).filter(element => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(element.tagName) && !sensitive.test(`${element.id} ${element.getAttribute('name') ?? ''} ${element.getAttribute('type') ?? ''}`)).slice(0, 800).map(element => ({ tag: element.tagName.toLowerCase(), id: element.id, class: String(element.className ?? '').slice(0, 180), text: element.children.length === 0 ? (element.textContent ?? '').trim().slice(0, 300) : '', attributes: Object.fromEntries([...element.attributes].filter(attr => ['name', 'type', 'role', 'aria-label', 'value', 'data-date', 'data-time', 'data-value', 'data-capacity', 'datetime'].includes(attr.name) && !sensitive.test(attr.value)).map(attr => [attr.name, attr.value.slice(0, 180)])) })), network: globalThis.__ttsFrameworkReadEvidence ?? null };
  });
  evidence.publicControls = await session.page.evaluate(() => [...document.querySelectorAll('input,select')].filter(element => element.getClientRects().length && !['password', 'email', 'tel', 'file'].includes(element.type) && !/password|secret|token|credential|email|phone|contact|username/iu.test(`${element.name} ${element.id}`)).slice(0, 80).map(element => ({ tag: element.tagName.toLowerCase(), id: element.id, name: element.name, type: element.type, value: element.value.slice(0, 180), selectedLabel: element instanceof HTMLSelectElement ? [...element.selectedOptions].map(option => option.text.slice(0, 160)).join(' ') : null, options: element instanceof HTMLSelectElement ? [...element.options].slice(0, 64).map(option => ({ value: option.value.slice(0, 180), text: option.text.slice(0, 160), selected: option.selected, disabled: option.disabled })) : null })));
  return evidence;
}

/** Closed predicate diagnostics only; this does not sanitize or admit a witness. */
export function nativeFrameWitnessFailure(witness, { pageUrl, visitedUrls, startedAt, workDeadline, selected, now = Date.now() }) {
  const keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().join(','):'';
  const stamp=Date.parse(witness?.observedAt);
  if(keys(witness)!=='documentHash,frames,kind,observedAt,pageUrl')return 'SHAPE';
  if(witness.kind!=='NATIVE_VISIBLE_FRAME')return 'KIND';
  if(witness.pageUrl!==pageUrl)return 'PAGE_BINDING';
  if(!sourceRoutingUrl(pageUrl))return 'PAGE_URL';
  if(!visitedUrls.includes(pageUrl))return 'PAGE_NOT_VISITED';
  if(!Number.isFinite(stamp)||new Date(stamp).toISOString()!==witness.observedAt)return 'TIMESTAMP';
  if(stamp<startedAt)return 'STALE';
  if(stamp>now+5000||stamp>workDeadline)return 'DEADLINE';
  if(typeof witness.documentHash!=='string'||!/^[a-f0-9]{64}$/u.test(witness.documentHash))return 'DOCUMENT_HASH';
  if(!Array.isArray(witness.frames)||witness.frames.length>24)return 'FRAME_ARRAY';
  if(new Set(witness.frames.map(f=>f?.src)).size!==witness.frames.length)return 'DUPLICATE_FRAME';
  for(const frame of witness.frames){
    if(keys(frame)!=='src,visible')return 'FRAME_SHAPE';
    if(frame.visible!==true)return 'FRAME_HIDDEN';
    if(!sourceRoutingUrl(frame.src))return 'FRAME_URL';
    if(frame.src===pageUrl)return 'FRAME_SELF';
  }
  if(selected!==undefined&&(witness.frames.length!==1||witness.frames[0].src!==selected))return 'SELECTION';
  return null;
}


const safeReason = value => String(value ?? '').slice(0,2000)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,'[REDACTED_EMAIL]')
  .replace(/(?:Bearer\s+|sk-|sess-)[A-Za-z0-9._~+\/-]+/gu,'[REDACTED]')
  .replace(/((?:token|password|secret|api.?key)\s*[:=]\s*)[^\s,;]+/giu,'$1[REDACTED]');
const closedFailure = error => {
  const code = error?.code ?? error?.message;
  return ['STAGEHAND_SOURCE_BUDGET_EXHAUSTED','SOURCE_DISCOVERY_ABORTED','WORK_DEADLINE_EXPIRED','ADAPTER_SOURCE_NOT_OBSERVED','FRAMEWORK_SOURCE_CANDIDATES_INVALID','FRAMEWORK_SOURCE_CANDIDATES_LIMIT',
    'LOCAL_MODEL_EXISTING_CHATGPT_LOGIN_REQUIRED','LOCAL_MODEL_TURN_FAILED','LOCAL_MODEL_ORIGINAL_DEADLINE','LOCAL_MODEL_CALL_CANCELLED',
    'SOL_ONLY_MODEL_RESULT_REQUIRED','STAGEHAND_VERSION_CHANGED','SOURCE_EVIDENCE_LIMIT','STAGEHAND_GUARDED_BROWSER_REQUIRED',
    'STAGEHAND_UNGUARDED_CONTEXT','STAGEHAND_GUARDED_TARGET_MISSING','STAGEHAND_NATIVE_HOST_DEADLINE',
    'STAGEHAND_NATIVE_HOST_SCOPE_INVALID','STAGEHAND_NATIVE_HOST_INVALID','STAGEHAND_NATIVE_HOST_FAILED',
    'STAGEHAND_GUARDED_SOURCE_REJECTED','OWNED_STAGEHAND_CDP_UNAVAILABLE','OWNED_PUBLIC_CDP_UNAVAILABLE',
    'PROVIDER_COORDINATION_UNAVAILABLE','STAGEHAND_SOURCE_OUTPUT_INVALID','STAGEHAND_SOURCE_LOADING_INCOMPLETE'].includes(code) ? code :
    error?.name === 'ZodError' ? 'STAGEHAND_SOURCE_OUTPUT_INVALID' : 'STAGEHAND_SOURCE_DISCOVERY_FAILED';
};
/** Finds an unverified route only. No method, inventory, identity proof or backend capability enters this module. */
export async function sourceDiscover({ job, cwd = process.cwd(), deadlineAt, signal, onMetrics, outputDirectory, createGuardedBrowser, sessionFactory = openStagehandSession } = {}) {
  const request = publicSourceJob(job, deadlineAt), workDeadline = Date.parse(request.workDeadlineAt);
  if (signal?.aborted) throw fail('SOURCE_DISCOVERY_ABORTED');
  if (outputDirectory !== undefined && (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory))) throw fail('STAGEHAND_ARTIFACT_DIRECTORY_INVALID');
  const report = { schemaVersion:1, framework:{...frameworkIdentity,name:'Stagehand',version:'4.3.0'}, frameworkMode:SOURCE_FRAMEWORK_MODE,
    frameworkRole:'SOURCE_DISCOVERY_ONLY', frameworkExtractedTimes:false, jobId:request.jobId, firstPickedUpAt:request.firstPickedUpAt,
    deadlineAt:request.deadlineAt, workDeadlineAt:request.workDeadlineAt, startedAt:new Date().toISOString(), outcome:'UNRESOLVED',
    adapterSourceProposal:null, matchingSlots:[], recipe:null, methodArtifactSaved:false, methodSaved:false, evidenceSummary:'',
    visitedUrls:[], officialLinkLedger:[], frameLedger:[], actions:[], actionAttempts:[], plannerFeedback:[],
    metrics:{model:'gpt-6.1-sol',reasoningEffort:'medium',modelTransport:'CODEX_APP_SERVER_CLIENT_LLM',completedSteps:0,calls:0,completedLocalCodexCalls:0,localCodexCalls:[]}, browserClosed:false, modelClosed:false };
  let session, startup, ownedBrowser, sourceError, phase='GUARDED_HOST', completed = false, consecutiveWaits = 0, rejections = 0;
  let finalDecision=null,stopCondition='RUNNING',lastActionKind=null,activeAct,activeFrame;
  report.nativeFrameNavigations=[];
  const acceptNativeFrames = (witness,pageUrl,startedAt,selected) => {
    const predicate=nativeFrameWitnessFailure(witness,{pageUrl,visitedUrls:report.visitedUrls,startedAt,workDeadline,selected});
    if(predicate)throw Object.assign(fail('STAGEHAND_SOURCE_OUTPUT_INVALID'),{stagehandFrameWitnessFailure:predicate});
    report.frameLedger.push(structuredClone(witness));return witness.frames.map(f=>f.src);
  };
  const onNativeFrameSourceWitness=witness=>{
    if(!activeFrame||activeFrame.witnessed)throw fail('STAGEHAND_SOURCE_OUTPUT_INVALID');
    acceptNativeFrames(witness,activeFrame.pageUrl,activeFrame.startedAt,activeFrame.url);activeFrame.witnessed=true;
  };
  // Only the private guarded-host callback may add this late native DOM edge.
  // Model actions and their summaries are never self-corroborating evidence.
  const onNativeSourceWitness = witness => {
    const stamp=Date.parse(witness?.observedAt),keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().join(','):'';
    if(!activeAct||activeAct.witnessed||keys(witness)!=='documentHash,kind,links,observedAt,pageUrl'||witness.kind!=='NATIVE_VISIBLE_DOM'||
      witness.pageUrl!==activeAct.pageUrl||!sourceRoutingUrl(witness.pageUrl)||!report.visitedUrls.includes(witness.pageUrl)||
      !Number.isFinite(stamp)||new Date(stamp).toISOString()!==witness.observedAt||stamp<activeAct.startedAt||stamp>Date.now()+5000||stamp>workDeadline||
      typeof witness.documentHash!=='string'||!/^[a-f0-9]{64}$/u.test(witness.documentHash)||!Array.isArray(witness.links)||witness.links.length!==1||
      keys(witness.links[0])!=='href,visible'||witness.links[0].visible!==true||!sourceRoutingUrl(witness.links[0].href))throw fail('STAGEHAND_SOURCE_OUTPUT_INVALID');
    activeAct.witnessed=true;report.officialLinkLedger.push(structuredClone(witness));
  };
  const sourceStartedAt=Date.now();
  const bounded = operation => {
    if (signal?.aborted) throw fail('SOURCE_DISCOVERY_ABORTED');
    if (Date.now() >= workDeadline) throw fail('STAGEHAND_SOURCE_BUDGET_EXHAUSTED');
    let timer, abort;
    return Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(fail('STAGEHAND_SOURCE_BUDGET_EXHAUSTED')),Math.max(1,workDeadline-Date.now()));
      abort=()=>reject(fail('SOURCE_DISCOVERY_ABORTED'));signal?.addEventListener('abort',abort,{once:true});
    })]).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);});
  };
  const metrics = () => {
    report.metrics.localCodexCalls = (session?.localCodexCalls ?? report.metrics.localCodexCalls).map(call=>({elapsedMs:call.elapsedMs,usage:call.usage,model:call.model,effort:call.effort}));
    report.metrics.completedLocalCodexCalls = report.metrics.localCodexCalls.length;
    report.metrics.attemptedLocalCodexCalls = Math.max(report.metrics.completedLocalCodexCalls,session?.modelCallCounts?.attempted??0);
    try { onMetrics?.(structuredClone(report.metrics)); } catch { /* Metrics never authorize or interrupt discovery. */ }
  };
  const persist = async () => {
    metrics(); if (!outputDirectory) return;
    const text=JSON.stringify(report,null,2);if(Buffer.byteLength(text)>2000000)throw fail('SOURCE_EVIDENCE_LIMIT');
    await mkdir(outputDirectory,{recursive:true});await writeFile(join(outputDirectory,'source-report.json'),text);
    await writeFile(join(outputDirectory,'source-stop.json'),JSON.stringify({schemaVersion:1,jobId:request.jobId,firstPickedUpAt:request.firstPickedUpAt,deadlineAt:request.deadlineAt,finalDecision,stopCondition}));
  };
  try {
    startup = Promise.resolve().then(async()=>{
      if(sessionFactory===openStagehandSession&&typeof createGuardedBrowser!=='function')throw fail('STAGEHAND_GUARDED_BROWSER_REQUIRED');
      if(createGuardedBrowser)ownedBrowser=await createGuardedBrowser({deadlineAt:request.workDeadlineAt,signal});
      if(completed||signal?.aborted||Date.now()>=workDeadline){await ownedBrowser?.close();throw fail('SOURCE_DISCOVERY_ABORTED');}
      return sessionFactory({model:'gpt-6.1-sol',deadline:workDeadline,cwd:resolve(cwd),signal,onMetrics:()=>metrics(),onNativeSourceWitness,onNativeFrameSourceWitness,sourceRoutingOnly:true,ownedBrowser});
    });
    startup.then(value=>{if(completed)void value.close().catch(()=>{});}).catch(()=>{});
    session = await bounded(()=>startup);
    report.metrics.browserStartupMs=session.startupMs;
    phase='INITIAL_SCRIPT';await bounded(()=>session.browser.context.addInitScript(installReadOnlyEvidence));
    phase='OPEN';
    lastActionKind='INITIAL_NAVIGATION';
    const response=await bounded(()=>session.goto(request.identity.officialUrl)), finalUrl=assertPublicUrl(await bounded(()=>session.page.url()));
    report.initialNavigation={requestedUrl:request.identity.officialUrl,finalUrl,status:response?.status()??null,redirectChainAvailable:false};
    report.visitedUrls.push(request.identity.officialUrl);if(!report.visitedUrls.includes(finalUrl))report.visitedUrls.push(finalUrl);
    for(let step=0;step<45;step++){
      phase='EVIDENCE';
      if(typeof session.settleSourceDocument==='function')await bounded(()=>session.settleSourceDocument());
      const evidence=await bounded(()=>pageEvidence(session));
      if(evidence.links.length>512)throw fail('SOURCE_EVIDENCE_LIMIT');
      if(evidence.url&&!report.visitedUrls.includes(evidence.url))report.visitedUrls.push(evidence.url);
      report.officialLinkLedger.push({kind:'NATIVE_VISIBLE_DOM',pageUrl:evidence.url,observedAt:evidence.observedAt,links:evidence.links});report.frameLedger.push({pageUrl:evidence.url,frames:evidence.frames});
      let frames=[];
      if(report.nativeFrameNavigations.length<2&&typeof session.observeFrameSources==='function'){
        const began=Date.now(),witness=await bounded(()=>session.observeFrameSources());frames=acceptNativeFrames(witness,evidence.url,began);
      }
      // A fresh native exact route can end routing without asking an LLM to
      // restate it. The private host has counted all current supported choices
      // (no truncated uniqueness) and re-attested the same document twice.
      let nativeChoice=null;
      if(typeof session.observeUniqueSource==='function'){
        const began=Date.now(),value=await bounded(()=>session.observeUniqueSource());
        nativeChoice=sourceRoutingUniqueWitness(value,{pageUrl:evidence.url,startedAt:began,deadline:workDeadline});
        if(nativeChoice&&await bounded(()=>session.page.url())!==evidence.url)nativeChoice=null;
        if(nativeChoice){
          const base={pageUrl:nativeChoice.pageUrl,observedAt:nativeChoice.observedAt,documentHash:nativeChoice.documentHash};
          if(nativeChoice.via!=='FRAME')report.officialLinkLedger.push({...base,kind:'NATIVE_VISIBLE_DOM',links:[{href:nativeChoice.url,visible:true}]});
          if(nativeChoice.via!=='LINK')report.frameLedger.push({...base,kind:'NATIVE_VISIBLE_FRAME',frames:[{src:nativeChoice.url,visible:true}]});
        }
      }
      if(Buffer.byteLength(JSON.stringify(report))>1500000){report.officialLinkLedger.pop();report.frameLedger.pop();throw fail('SOURCE_EVIDENCE_LIMIT');}
      const candidates=observedBookingSourceCandidates(report,request.identity.officialUrl,sourceRoutingUrl,{sourceDiscoveryOnly:true});
      report.eligibleBookingSourceUrls=candidates;report.sourceRoutingContext=sourceRoutingContext(report,candidates);
      if(nativeChoice&&candidates.includes(nativeChoice.url)){
        finalDecision=null; // The stopping choice is native, not an earlier model decision.
        report.adapterSourceProposal={schemaVersion:1,kind:'EXISTING_ADAPTER_SOURCE',bookingUrl:nativeChoice.url};
        report.outcome='SOURCE_PROPOSED_UNVERIFIED';report.decisionOrigin='NATIVE_UNIQUE_SUPPORTED_SOURCE';
        report.evidenceSummary='One freshly re-attested native public routing source; identity, configuration and availability remain unverified.';
        stopCondition='SOURCE_FOUND';await persist();break;
      }
      report.metrics.calls++;
      frames=frames.filter(value=>candidates.includes(value));
      const instruction=buildSourceDiscoveryInstruction({identity:request.identity,target:request.target,input:request.input},candidates,null,report.sourceRoutingContext,frames)+
        ' Current bounded public evidence: '+JSON.stringify(prioritizedPublicEvidence(evidence,{maxCharacters:60000,includeDom:false}));
      phase='EXTRACT';const extraction=await bounded(()=>session.extract(instruction,sourceDecisionFor(candidates,frames))),decision=sourceDecisionFor(candidates,frames).parse(extraction.data);
      finalDecision=decision.decision;report.metrics.completedSteps=step+1;report.evidenceSummary=safeReason(decision.reason);await persist();
      if(decision.decision==='SOURCE_FOUND'){report.adapterSourceProposal=readHybridSourceExport(decision,candidates);report.outcome='SOURCE_PROPOSED_UNVERIFIED';stopCondition='SOURCE_FOUND';break;}
      if(decision.decision==='UNRESOLVED'){
        // A model's old snapshot cannot close discovery while the same native
        // document is still parsing, or a new main document has since arrived.
        if(typeof session.readSourceDocumentReadiness==='function'&&(!sourceDocumentSettled(await bounded(()=>session.readSourceDocumentReadiness()))||
          await bounded(()=>session.page.url())!==evidence.url))continue;
        stopCondition='EXPLICIT_UNRESOLVED';break;
      }
      if(decision.decision==='OPEN_FRAME'){
        lastActionKind='openObservedFrameSource';
        if(!frames.includes(decision.bookingUrl)||report.nativeFrameNavigations.length>=2||typeof session.openObservedFrameSource!=='function')throw fail('STAGEHAND_SOURCE_OUTPUT_INVALID');
        activeFrame={pageUrl:evidence.url,url:decision.bookingUrl,startedAt:Date.now()};
        let entry;try{phase='OPEN';entry=await bounded(()=>session.openObservedFrameSource(decision.bookingUrl));if(!activeFrame.witnessed)throw fail('STAGEHAND_SOURCE_OUTPUT_INVALID');}finally{activeFrame=undefined;}
        report.nativeFrameNavigations.push(entry);
        if(nativeFrameNavigations(report,sourceRoutingUrl).length!==report.nativeFrameNavigations.length)throw fail('STAGEHAND_SOURCE_OUTPUT_INVALID');
        if(!report.visitedUrls.includes(entry.finalUrl))report.visitedUrls.push(entry.finalUrl);
        report.actions.push({action:{method:'openObservedFrameSource'},sourceUrl:entry.pageUrl,observedTarget:{tag:'IFRAME',href:entry.frameUrl},afterUrl:entry.finalUrl,openedNewPage:false});
        await persist();continue;
      }
      if(decision.decision==='WAIT'){
        if(++consecutiveWaits>3){report.frameworkFailureCode='STAGEHAND_SOURCE_LOADING_INCOMPLETE';stopCondition='WAIT_LIMIT';break;}
        await bounded(()=>new Promise(done=>setTimeout(done,Math.min(1500,Math.max(1,workDeadline-Date.now())))));continue;
      }
      consecutiveWaits=0;const instructionText=decision.nextActionInstruction;
      if(!instructionText.trim()){stopCondition='EMPTY_CONTINUE';break;}
      report.metrics.calls++;
      phase='OBSERVE';const observation=await bounded(()=>session.observe(instructionText+'. Return one supported read-only navigation action only. Opening an official public availability link labelled Book is permitted. Never select an individual time, filter date/player/duration, authenticate, transact, contact anyone, or solve a challenge.')),action=observation.data?.[0];
      if(!action){if(++rejections>=3){report.frameworkFailureCode='STAGEHAND_SOURCE_ACTION_UNAVAILABLE';stopCondition='ACTION_UNAVAILABLE_LIMIT';break;}continue;}
      const attempt={action:observedActionSummary(action),sourceUrl:evidence.url,status:'OBSERVED'};report.actionAttempts.push(attempt);
      lastActionKind=['click','fill','type','selectOptionFromDropdown','press','scrollTo','nextChunk','prevChunk','hover'].includes(action.method)?action.method:null;
      try{
        phase='ACT';activeAct={pageUrl:evidence.url,startedAt:Date.now()};
        let result;try{result=await bounded(()=>session.act(action));}finally{activeAct=undefined;}
        attempt.status='EXECUTED';attempt.afterUrl=result.afterUrl;
        if(!report.visitedUrls.includes(result.afterUrl))report.visitedUrls.push(result.afterUrl);
        report.actions.push({action:observedActionSummary(action),sourceUrl:evidence.url,observedTarget:observedTargetSummary(result.before),afterUrl:result.afterUrl,openedNewPage:result.openedNewPage});rejections=0;
      }catch(error){
        if(!['METHOD_NOT_PERMITTED','ARGUMENTS_NOT_PERMITTED','ACTION_TARGET_REJECTED','SDK_ACTION_FAILED','SDK_ACTION_POSTCONDITION_FAILED'].includes(error.message))throw error;
        attempt.status='REJECTED';attempt.reason=error.message;if(sourceGuardReasons.includes(error.stagehandGuardReason))attempt.guardReason=error.stagehandGuardReason;
        const guard=projectActionGuardDiagnostic(error.stagehandActionDiagnostic);if(guard)Object.assign(attempt,guard);
        if(++rejections>=3){report.frameworkFailureCode='STAGEHAND_SOURCE_ACTION_REJECTED';stopCondition='ACTION_REJECTED_LIMIT';break;}
      }
      await persist();
    }
  }catch(error){sourceError=error;report.outcome='UNRESOLVED';report.adapterSourceProposal=null;report.frameworkFailureCode=closedFailure(error);stopCondition='ERROR';}
  finally{
    completed=true;metrics();
    if(stopCondition==='RUNNING')stopCondition='STEP_LIMIT';
    if(session){try{const closed=await session.close();report.browserClosed=closed.browserClosed===true;report.modelClosed=closed.modelClosed===true;}catch{report.browserClosed=false;report.browserCleanupErrorCode='STAGEHAND_BROWSER_CLEANUP_FAILED';}}
    else if(ownedBrowser){try{report.browserClosed=(await ownedBrowser.close()).browserClosed===true;}catch{report.browserClosed=false;}}
    if(!report.browserClosed||!report.modelClosed){if(report.outcome==='SOURCE_PROPOSED_UNVERIFIED'&&!sourceError)sourceError=Object.assign(Error('STAGEHAND_SOURCE_CLEANUP_UNCONFIRMED'),{stagehandPhase:'CLOSE'});report.outcome='UNRESOLVED';report.adapterSourceProposal=null;report.frameworkFailureCode??='STAGEHAND_SOURCE_CLEANUP_UNCONFIRMED';stopCondition='CLEANUP_UNCONFIRMED';}
    if(report.outcome!=='SOURCE_PROPOSED_UNVERIFIED')report.sourceDiagnostic=sourceFailureDiagnostic({error:sourceError,phase,report,startedAt:sourceStartedAt,
      cleanup:{browserClosed:report.browserClosed,modelClosed:report.modelClosed},modelAttempts:report.metrics.attemptedLocalCodexCalls,modelFailure:session?.lastModelFailure,ownedCdpFailure:session?.ownedCdpFailure,nativeRouterFailure:session?.nativeRouterFailure,
      sourceStop:{finalDecision,condition:stopCondition,lastActionKind},documentReadiness:session?.sourceDocumentReadiness});
    report.finishedAt=new Date().toISOString();report.elapsedFromFirstPickupMs=Date.now()-Date.parse(request.firstPickedUpAt);
    await persist();
  }
  return report;
}
export const runStagehandSourceDiscovery = sourceDiscover;
