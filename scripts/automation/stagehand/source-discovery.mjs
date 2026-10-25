import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { openStagehandSession, loadStagehandRuntime, assertPublicUrl, frameworkIdentity, observedActionSummary, observedTargetSummary } from './driver.mjs';
import { installReadOnlyEvidence } from './read-only-evidence.mjs';
import { prioritizedPublicEvidence, publicEvidenceUrl } from './public-evidence.mjs';
import { observedBookingSourceCandidates } from './source-provenance.mjs';

export const SOURCE_BUDGET_MS = 120000;
export const SOURCE_FRAMEWORK_MODE = 'HYBRID_SOURCE_DISCOVERY';
const fail = code => Object.assign(new Error(code), { code });
export const adapterSourceProposalSchema = z.object({schemaVersion:z.literal(1),kind:z.literal('EXISTING_ADAPTER_SOURCE'),
  bookingUrl:z.string().max(2048).refine(value=>Boolean(publicEvidenceUrl(value)))}).strict();
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
export async function prepareSourceDiscovery({ cwd = process.cwd(), loadRuntime = loadStagehandRuntime, loadHelpers, read = readFileSync } = {}) {
  await loadRuntime();
  const helpers = loadHelpers ? await loadHelpers() : await import(pathToFileURL(join(resolve(cwd),'scripts/automation/course-discovery-worker.mjs')).href);
  helpers.prepareDiscoveryModelCatalog({ model: 'gpt-6.1-sol' });
  helpers.resolveDiscoveryCli(resolve(cwd));
  const auth = JSON.parse(read(join(process.env.CODEX_HOME || join(homedir(),'.codex'),'auth.json'),'utf8'));
  if (auth.auth_mode !== 'chatgpt' || typeof auth.tokens?.access_token !== 'string' || !auth.tokens.access_token) throw fail('LOCAL_MODEL_EXISTING_CHATGPT_LOGIN_REQUIRED');
  return { ready: true, model: 'gpt-6.1-sol', reasoningEffort: 'medium', framework: { name:'Stagehand',version:'4.3.0' }, chatgptSignInFileAvailable: true, readinessAccountRpcPerformed:false, accountTypeCheckedByClientBeforeModelCall:true };
}

export const sourceDecision = z.object({ decision: z.enum(['CONTINUE', 'WAIT', 'SOURCE_FOUND', 'UNRESOLVED']), reason: z.string(), nextActionInstruction: z.string(), bookingUrl: z.string().nullable() }).strict();
export function sourceDecisionFor(candidates) {
  if (!Array.isArray(candidates) || candidates.length > 32 || new Set(candidates).size !== candidates.length || candidates.some(url => !publicEvidenceUrl(url))) throw new Error('FRAMEWORK_SOURCE_CANDIDATES_INVALID');
  return sourceDecision.extend({decision:z.enum(candidates.length?['CONTINUE','WAIT','SOURCE_FOUND','UNRESOLVED']:['CONTINUE','WAIT','UNRESOLVED']),
    bookingUrl:candidates.length?z.enum(candidates).nullable():z.null()});
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
  const context = { initialNavigation, completedAnchorClicks, omittedClickCount: rows.length - completedAnchorClicks.length };
  return { ...context, sha256: createHash('sha256').update(JSON.stringify(context)).digest('hex') };
}
export function buildSourceDiscoveryInstruction(ordinaryRequest, candidates, priorInspectionFeedback = null, routingContext = null) {
  return sourceDiscoveryCoreInstruction(ordinaryRequest, candidates, priorInspectionFeedback) +
    ` Recorded completed native routing observations from this same attempt: ${JSON.stringify(routingContext)}. This extraction is stateless: use this supplied history instead of assuming that the current DOM contains previous clicks. An eligibleBookingSource:true completed click with landingChanged:true records the already performed official-linked routing step. Select its exact eligible href when appropriate; do not repeat navigation or browse/filter actions merely because the current landing omits the earlier link. This history grants no fresh identity, availability, adapter metadata or replay proof; the unchanged provenance validator and fixed inspector retain authority.`;
}
function sourceDiscoveryCoreInstruction(ordinaryRequest, candidates, priorInspectionFeedback = null) {
  return `Discover only an official-linked signed-out public availability routing source for this ordinary input: ${JSON.stringify(ordinaryRequest)}. Follow currently observed public links; do not use prior provider routes or guessed configuration. This is a separately attributed hybrid source-discovery arm. Do not extract times, build a recipe, select dates/players/duration, inspect private data, authenticate, solve challenges or select an available slot. Eligibility is routing provenance only. Do not stop on the informational startup official homepage or its redirect aliases. Follow the actual visible public booking link, same-origin booking path or visible embedded booking widget first. After the native SDK actually clicks that official-linked source and observes its safe landing, select the corresponding exact eligible ancestor even if its application shell is blank, loading, or redirects to another public path. A hydrated booking interface is not required for this source-only proposal. Copy one eligibleBookingSourceUrls entry verbatim; never substitute the current filtered or redirected address. Return SOURCE_FOUND for an appropriate observed source and summarize its routing observation in reason. Otherwise return one CONTINUE navigation instruction, WAIT for a visible loader, or UNRESOLVED. Source choice grants no identity, availability or method proof. The fixed reader must freshly inspect the exact official-linked source and perform normal verification. eligibleBookingSourceUrls=${JSON.stringify(candidates)}. Never normalize, shorten, drop or change tenant/query parameters. Use only observed official links. Return bookingUrl:null unless SOURCE_FOUND. Own same-job prior inspection failure: ${typeof priorInspectionFeedback==='string'?priorInspectionFeedback.slice(0,6000):'none'}. This distinct historical inspection feedback is not an independent replay, source hint from another arm, or current proof; obtain fresh public observations and retain every identity/source guard.`;
}

async function pageEvidence(session) {
  const evidence = await session.page.evaluate(() => {
    const sensitive = /password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|customer|contact|attendee|payment|card|profile|account|member/iu;
    const safe = value => typeof globalThis.__ttsSafePublicEvidenceUrl === 'function' ? globalThis.__ttsSafePublicEvidenceUrl(value) : null;
    const rendered = { visible(element) { if (!element?.isConnected || !element.getClientRects().length) return false; for (let node=element;node;node=node.parentElement) { const style=getComputedStyle(node); if(node.hidden || style.display==='none' || style.visibility==='hidden' || Number(style.opacity)===0)return false; } return true; } };
    const visible = element => rendered.visible(element);
    return { url: safe(location.href), title: document.title.slice(0, 300), links: [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 160).map(element => ({ text: (element.innerText ?? '').trim().slice(0, 180), href: safe(element.href) })).filter(item => item.href), frames: [...document.querySelectorAll('iframe[src]')].slice(0, 24).map(element => ({ src: safe(element.src), visible: visible(element), title: (element.title ?? '').slice(0, 120) })), dom: [...document.querySelectorAll('body *')].filter(visible).filter(element => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(element.tagName) && !sensitive.test(`${element.id} ${element.getAttribute('name') ?? ''} ${element.getAttribute('type') ?? ''}`)).slice(0, 800).map(element => ({ tag: element.tagName.toLowerCase(), id: element.id, class: String(element.className ?? '').slice(0, 180), text: element.children.length === 0 ? (element.textContent ?? '').trim().slice(0, 300) : '', attributes: Object.fromEntries([...element.attributes].filter(attr => ['name', 'type', 'role', 'aria-label', 'value', 'data-date', 'data-time', 'data-value', 'data-capacity', 'datetime'].includes(attr.name) && !sensitive.test(attr.value)).map(attr => [attr.name, attr.value.slice(0, 180)])) })), network: globalThis.__ttsFrameworkReadEvidence ?? null };
  });
  evidence.publicControls = await session.page.evaluate(() => [...document.querySelectorAll('input,select')].filter(element => element.getClientRects().length && !['password', 'email', 'tel', 'file'].includes(element.type) && !/password|secret|token|credential|email|phone|contact|username/iu.test(`${element.name} ${element.id}`)).slice(0, 80).map(element => ({ tag: element.tagName.toLowerCase(), id: element.id, name: element.name, type: element.type, value: element.value.slice(0, 180), selectedLabel: element instanceof HTMLSelectElement ? [...element.selectedOptions].map(option => option.text.slice(0, 160)).join(' ') : null, options: element instanceof HTMLSelectElement ? [...element.options].slice(0, 64).map(option => ({ value: option.value.slice(0, 180), text: option.text.slice(0, 160), selected: option.selected, disabled: option.disabled })) : null })));
  return evidence;
}


const safeReason = value => String(value ?? '').slice(0,2000)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu,'[REDACTED_EMAIL]')
  .replace(/(?:Bearer\s+|sk-|sess-)[A-Za-z0-9._~+\/-]+/gu,'[REDACTED]')
  .replace(/((?:token|password|secret|api.?key)\s*[:=]\s*)[^\s,;]+/giu,'$1[REDACTED]');
const closedFailure = error => {
  const code = error?.code ?? error?.message;
  return ['STAGEHAND_SOURCE_BUDGET_EXHAUSTED','SOURCE_DISCOVERY_ABORTED','WORK_DEADLINE_EXPIRED','ADAPTER_SOURCE_NOT_OBSERVED','FRAMEWORK_SOURCE_CANDIDATES_INVALID',
    'LOCAL_MODEL_EXISTING_CHATGPT_LOGIN_REQUIRED','LOCAL_MODEL_TURN_FAILED','LOCAL_MODEL_ORIGINAL_DEADLINE','LOCAL_MODEL_CALL_CANCELLED',
    'SOL_ONLY_MODEL_RESULT_REQUIRED','STAGEHAND_VERSION_CHANGED','SOURCE_EVIDENCE_LIMIT','STAGEHAND_GUARDED_BROWSER_REQUIRED',
    'STAGEHAND_UNGUARDED_CONTEXT','STAGEHAND_GUARDED_TARGET_MISSING','STAGEHAND_NATIVE_HOST_DEADLINE',
    'STAGEHAND_NATIVE_HOST_SCOPE_INVALID','STAGEHAND_NATIVE_HOST_INVALID','STAGEHAND_NATIVE_HOST_FAILED',
    'STAGEHAND_GUARDED_SOURCE_REJECTED','OWNED_STAGEHAND_CDP_UNAVAILABLE','OWNED_PUBLIC_CDP_UNAVAILABLE',
    'PROVIDER_COORDINATION_UNAVAILABLE'].includes(code) ? code :
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
  let session, startup, ownedBrowser, completed = false, consecutiveWaits = 0, rejections = 0;
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
    try { onMetrics?.(structuredClone(report.metrics)); } catch { /* Metrics never authorize or interrupt discovery. */ }
  };
  const persist = async () => {
    metrics(); if (!outputDirectory) return;
    const text=JSON.stringify(report,null,2);if(Buffer.byteLength(text)>2000000)throw fail('SOURCE_EVIDENCE_LIMIT');
    await mkdir(outputDirectory,{recursive:true});await writeFile(join(outputDirectory,'source-report.json'),text);
  };
  try {
    startup = Promise.resolve().then(async()=>{
      if(sessionFactory===openStagehandSession&&typeof createGuardedBrowser!=='function')throw fail('STAGEHAND_GUARDED_BROWSER_REQUIRED');
      if(createGuardedBrowser)ownedBrowser=await createGuardedBrowser({deadlineAt:request.workDeadlineAt,signal});
      if(completed||signal?.aborted||Date.now()>=workDeadline){await ownedBrowser?.close();throw fail('SOURCE_DISCOVERY_ABORTED');}
      return sessionFactory({model:'gpt-6.1-sol',deadline:workDeadline,cwd:resolve(cwd),signal,onMetrics:()=>metrics(),ownedBrowser});
    });
    startup.then(value=>{if(completed)void value.close().catch(()=>{});}).catch(()=>{});
    session = await bounded(()=>startup);
    report.metrics.browserStartupMs=session.startupMs;
    await bounded(()=>session.browser.context.addInitScript(installReadOnlyEvidence));
    const response=await bounded(()=>session.goto(request.identity.officialUrl)), finalUrl=assertPublicUrl(await bounded(()=>session.page.url()));
    report.initialNavigation={requestedUrl:request.identity.officialUrl,finalUrl,status:response?.status()??null,redirectChainAvailable:false};
    report.visitedUrls.push(request.identity.officialUrl);if(!report.visitedUrls.includes(finalUrl))report.visitedUrls.push(finalUrl);
    for(let step=0;step<45;step++){
      const evidence=await bounded(()=>pageEvidence(session));
      if(evidence.url&&!report.visitedUrls.includes(evidence.url))report.visitedUrls.push(evidence.url);
      report.officialLinkLedger.push({pageUrl:evidence.url,links:evidence.links});report.frameLedger.push({pageUrl:evidence.url,frames:evidence.frames});
      if(Buffer.byteLength(JSON.stringify(report))>1500000){report.officialLinkLedger.pop();report.frameLedger.pop();throw fail('SOURCE_EVIDENCE_LIMIT');}
      const candidates=observedBookingSourceCandidates(report,request.identity.officialUrl,publicEvidenceUrl,{sourceDiscoveryOnly:true});
      report.eligibleBookingSourceUrls=candidates;report.sourceRoutingContext=sourceRoutingContext(report,candidates);report.metrics.calls++;
      const instruction=buildSourceDiscoveryInstruction({identity:request.identity,target:request.target,input:request.input},candidates,null,report.sourceRoutingContext)+
        ' Current bounded public evidence: '+JSON.stringify(prioritizedPublicEvidence(evidence,{maxCharacters:60000,includeDom:false}));
      const extraction=await bounded(()=>session.extract(instruction,sourceDecisionFor(candidates))),decision=sourceDecision.parse(extraction.data);
      report.metrics.completedSteps=step+1;report.evidenceSummary=safeReason(decision.reason);await persist();
      if(decision.decision==='SOURCE_FOUND'){report.adapterSourceProposal=readHybridSourceExport(decision,candidates);report.outcome='SOURCE_PROPOSED_UNVERIFIED';break;}
      if(decision.decision==='UNRESOLVED')break;
      if(decision.decision==='WAIT'){
        if(++consecutiveWaits>3){report.frameworkFailureCode='STAGEHAND_SOURCE_LOADING_INCOMPLETE';break;}
        await bounded(()=>new Promise(done=>setTimeout(done,Math.min(1500,Math.max(1,workDeadline-Date.now())))));continue;
      }
      consecutiveWaits=0;const instructionText=decision.nextActionInstruction;
      if(!instructionText.trim())break;
      report.metrics.calls++;
      const observation=await bounded(()=>session.observe(instructionText+'. Return one supported read-only navigation action only. Opening an official public availability link labelled Book is permitted. Never select an individual time, filter date/player/duration, authenticate, transact, contact anyone, or solve a challenge.')),action=observation.data?.[0];
      if(!action){if(++rejections>=3){report.frameworkFailureCode='STAGEHAND_SOURCE_ACTION_UNAVAILABLE';break;}continue;}
      const attempt={action:observedActionSummary(action),sourceUrl:evidence.url,status:'OBSERVED'};report.actionAttempts.push(attempt);
      try{
        const result=await bounded(()=>session.act(action));attempt.status='EXECUTED';attempt.afterUrl=result.afterUrl;
        if(!report.visitedUrls.includes(result.afterUrl))report.visitedUrls.push(result.afterUrl);
        report.actions.push({action:observedActionSummary(action),sourceUrl:evidence.url,observedTarget:observedTargetSummary(result.before),afterUrl:result.afterUrl,openedNewPage:result.openedNewPage});rejections=0;
      }catch(error){
        if(!['METHOD_NOT_PERMITTED','ARGUMENTS_NOT_PERMITTED','ACTION_TARGET_REJECTED','SDK_ACTION_FAILED','SDK_ACTION_POSTCONDITION_FAILED'].includes(error.message))throw error;
        attempt.status='REJECTED';attempt.reason=error.message;if(++rejections>=3){report.frameworkFailureCode='STAGEHAND_SOURCE_ACTION_REJECTED';break;}
      }
      await persist();
    }
  }catch(error){report.outcome='UNRESOLVED';report.adapterSourceProposal=null;report.frameworkFailureCode=closedFailure(error);}
  finally{
    completed=true;metrics();
    if(session){try{const closed=await session.close();report.browserClosed=closed.browserClosed===true;report.modelClosed=closed.modelClosed===true;}catch{report.browserClosed=false;report.browserCleanupErrorCode='STAGEHAND_BROWSER_CLEANUP_FAILED';}}
    else if(ownedBrowser){try{report.browserClosed=(await ownedBrowser.close()).browserClosed===true;}catch{report.browserClosed=false;}}
    if(!report.browserClosed||!report.modelClosed){report.outcome='UNRESOLVED';report.adapterSourceProposal=null;report.frameworkFailureCode??='STAGEHAND_SOURCE_CLEANUP_UNCONFIRMED';}
    report.finishedAt=new Date().toISOString();report.elapsedFromFirstPickupMs=Date.now()-Date.parse(request.firstPickedUpAt);
    await persist();
  }
  return report;
}
export const runStagehandSourceDiscovery = sourceDiscover;
