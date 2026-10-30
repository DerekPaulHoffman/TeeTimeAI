// Fixed collector provenance only. This module performs no I/O or navigation.
import { publicEvidenceUrl } from './public-evidence.mjs';
import { isEzLinksLegacyGateway } from './public-source-gateway.mjs';
export const SOURCE_CANDIDATE_LIMIT = 160;
export const SOURCE_CANDIDATE_URL_BYTES = 65536;
/** Private controller history events on a completed, unchanged native document.
 * A same-document route is neither an HTTP redirect nor availability proof. */
export function nativeHistoryNavigations(report, isPublic = publicEvidenceUrl) {
  const started=Date.parse(report?.startedAt),finished=report?.finishedAt===undefined?Date.now()+5000:Date.parse(report.finishedAt),seen=new Set();
  return rows(report?.nativeHistoryNavigations,4).filter(row=>{
    if(!row||Object.keys(row).sort().join(',')!=='completedAt,documentHash,documentUrl,finalStatus,finalUrl,kind,observedAt'||
      row.kind!=='NATIVE_DOCUMENT_HISTORY_ROUTE'||row.finalStatus!==200||!isPublic(row.documentUrl)||!isPublic(row.finalUrl)||
      norm(row.documentUrl)!==row.documentUrl||norm(row.finalUrl)!==row.finalUrl||row.documentUrl===row.finalUrl||
      new URL(row.documentUrl).origin!==new URL(row.finalUrl).origin||!/^[a-f0-9]{64}$/u.test(row.documentHash??'')||
      ![started,finished,Date.parse(row.observedAt),Date.parse(row.completedAt)].every(Number.isFinite)||
      new Date(row.observedAt).toISOString()!==row.observedAt||new Date(row.completedAt).toISOString()!==row.completedAt||
      Date.parse(row.observedAt)<started||Date.parse(row.completedAt)<Date.parse(row.observedAt)||Date.parse(row.completedAt)>finished||
      ![row.documentUrl,row.finalUrl].every(url=>rows(report.visitedUrls,1024).includes(url))||
      !rows(report.officialLinkLedger,512).some(w=>w.kind==='NATIVE_VISIBLE_DOM'&&w.pageUrl===row.finalUrl&&w.documentHash===row.documentHash&&w.observedAt===row.completedAt))return false;
    const key=JSON.stringify([row.documentUrl,row.finalUrl]);if(seen.has(key))return false;seen.add(key);return true;
  });
}
/** Stage a private native history witness atomically. The served document can
 * precede the first visible URL when its own script immediately rewrites it. */
export function stageNativeHistoryNavigation(report, value, isPublic = publicEvidenceUrl) {
  if(!value||!rows(report?.visitedUrls,1024).includes(value.finalUrl)||
    !rows(report?.officialLinkLedger,512).some(row=>row.kind==='NATIVE_VISIBLE_DOM'&&row.pageUrl===value.finalUrl)||
    !Array.isArray(report?.nativeHistoryNavigations)||report.nativeHistoryNavigations.length>=4||
    !Array.isArray(report?.officialLinkLedger)||report.officialLinkLedger.length>=512)
    throw Error('STAGEHAND_SOURCE_OUTPUT_INVALID');
  const visitedUrls=[...new Set([...rows(report.visitedUrls,1024),value.documentUrl,value.finalUrl])];
  if(visitedUrls.length>1024)throw Error('STAGEHAND_SOURCE_OUTPUT_INVALID');
  const staged={...report,visitedUrls,
    officialLinkLedger:[...report.officialLinkLedger,{kind:'NATIVE_VISIBLE_DOM',pageUrl:value.finalUrl,observedAt:value.completedAt,documentHash:value.documentHash,links:[]}],
    nativeHistoryNavigations:[...report.nativeHistoryNavigations,value]};
  if(nativeHistoryNavigations(staged,isPublic).length!==staged.nativeHistoryNavigations.length)
    throw Error('STAGEHAND_SOURCE_OUTPUT_INVALID');
  return staged;
}
export function assertSourceCandidateBudget(candidates) {
  if (!Array.isArray(candidates) || candidates.length > SOURCE_CANDIDATE_LIMIT ||
      candidates.reduce((bytes, value) => bytes + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : SOURCE_CANDIDATE_URL_BYTES + 1), 0) > SOURCE_CANDIDATE_URL_BYTES)
    throw new Error('FRAMEWORK_SOURCE_CANDIDATES_LIMIT');
  return candidates;
}
const rows = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
const norm = value => publicEvidenceUrl(value);
/** Current-root presence is routing data, never a booking URL edge. */
export function rootWidgetWitness(value, { pageUrl, startedAt, finishedAt, isPublic = publicEvidenceUrl } = {}) {
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  if(keys!=='documentHash,kind,observedAt,pageUrl,widgetKind'||value.kind!=='NATIVE_ROOT_PUBLIC_WIDGET'||
    !['CALENDAR','PUBLIC_FILTERS','SERVICE_CATALOG'].includes(value.widgetKind)||typeof value.documentHash!=='string'||!/^[a-f0-9]{64}$/u.test(value.documentHash)||
    !isPublic(value.pageUrl)||value.pageUrl!==pageUrl)return null;
  const stamp=Date.parse(value.observedAt);
  if(!Number.isFinite(stamp)||new Date(stamp).toISOString()!==value.observedAt||!Number.isFinite(startedAt)||!Number.isFinite(finishedAt)||stamp<startedAt||stamp>finishedAt)return null;
  return {...value};
}
export function rootWidgetRoutingWitness(report, officialUrl, isPublic = publicEvidenceUrl) {
  const initial=report?.initialNavigation,witness=report?.rootWidgetWitness;
  if(initial?.requestedUrl!==officialUrl||!isPublic(officialUrl)||!isPublic(initial.finalUrl)||initial.status!==200||
    !Array.isArray(report.visitedUrls)||!report.visitedUrls.includes(witness?.pageUrl))return null;
  try{
    const root=new URL(initial.finalUrl),current=new URL(witness.pageUrl);
    if(root.origin!==current.origin||root.pathname!==current.pathname||root.search!==current.search)return null;
  }catch{return null;}
  return rootWidgetWitness(witness,{pageUrl:witness.pageUrl,startedAt:Date.parse(report.startedAt),finishedAt:Date.parse(report.finishedAt),isPublic});
}
/** Explicit non-visible document-link routing, never a synthetic click/frame. */
export function nativeIntermediaryNavigations(report, isPublic = publicEvidenceUrl) {
  const valid=value=>typeof value==='string'&&norm(value)===value&&Boolean(isPublic(value));
  const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
  const keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().join(','):'';
  const started=Date.parse(report?.startedAt),finished=report?.finishedAt===undefined?Date.now()+5000:Date.parse(report.finishedAt);
  return rows(report?.nativeIntermediaryNavigations,2).filter(row=>{
    if(keys(row)!=='completedAt,documentHash,finalDocumentHash,finalUrl,kind,observedAt,pageUrl,redirects,url'||row.kind!=='NATIVE_PUBLIC_BOOKING_INTERMEDIARY_OPEN'||
      ![row.pageUrl,row.url,row.finalUrl].every(valid)||new URL(row.pageUrl).origin!==new URL(row.url).origin||new URL(row.url).search||new URL(row.url).hash||row.url===row.pageUrl||
      !sha(row.documentHash)||!sha(row.finalDocumentHash)||!Number.isFinite(started)||!Number.isFinite(finished)||
      !Number.isFinite(Date.parse(row.observedAt))||!Number.isFinite(Date.parse(row.completedAt))||Date.parse(row.observedAt)<started||Date.parse(row.completedAt)<Date.parse(row.observedAt)||Date.parse(row.completedAt)>finished||
      !Array.isArray(row.redirects)||row.redirects.length>5||!rows(report.officialLinkLedger,512).some(w=>w.kind==='NATIVE_PUBLIC_BOOKING_INTERMEDIARY'&&w.pageUrl===row.pageUrl&&w.observedAt===row.observedAt&&w.documentHash===row.documentHash&&
        w.links?.length===1&&w.links[0].visible===false&&w.links[0].href===row.url))return false;
    let current=row.url;const seen=new Set([current]);
    for(const hop of row.redirects){if(keys(hop)!=='completed,fromUrl,status,toUrl'||hop.completed!==true||![301,302,303,307,308].includes(hop.status)||hop.fromUrl!==current||!valid(hop.toUrl)||seen.has(hop.toUrl))return false;current=hop.toUrl;seen.add(current);}
    return current===row.finalUrl;
  });
}
/** Private fixed-controller frame entries, never SDK/model action summaries. */
export function nativeFrameNavigations(report, isPublic = publicEvidenceUrl) {
  const valid = value => typeof value === 'string' && norm(value) === value && Boolean(isPublic(value));
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  const keys = value => value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';
  const started=Date.parse(report?.startedAt),finished=report?.finishedAt===undefined?Date.now()+5000:Date.parse(report.finishedAt);
  return rows(report?.nativeFrameNavigations,2).filter(row=>{
    if(keys(row)!=='completedAt,documentHash,finalDocumentHash,finalUrl,frameUrl,kind,observedAt,pageUrl,redirects'||row.kind!=='NATIVE_FRAME_SOURCE_OPEN'||
      ![row.pageUrl,row.frameUrl,row.finalUrl].every(valid)||!sha(row.documentHash)||!sha(row.finalDocumentHash)||
      !Number.isFinite(started)||!Number.isFinite(finished)||!Number.isFinite(Date.parse(row.observedAt))||!Number.isFinite(Date.parse(row.completedAt))||
      Date.parse(row.observedAt)<started||Date.parse(row.completedAt)<Date.parse(row.observedAt)||Date.parse(row.completedAt)>finished||
      !Array.isArray(row.redirects)||row.redirects.length>5||!rows(report.frameLedger,512).some(w=>w.kind==='NATIVE_VISIBLE_FRAME'&&w.pageUrl===row.pageUrl&&
        w.observedAt===row.observedAt&&w.documentHash===row.documentHash&&rows(w.frames,24).some(f=>f.visible===true&&f.src===row.frameUrl)))return false;
    let current=row.frameUrl;const seen=new Set([current]);
    for(const hop of row.redirects){
      if(keys(hop)!=='completed,fromUrl,status,toUrl'||hop.completed!==true||![301,302,303,307,308].includes(hop.status)||
        hop.fromUrl!==current||!valid(hop.toUrl)||seen.has(hop.toUrl))return false;
      current=hop.toUrl;seen.add(current);
    }
    return current===row.finalUrl;
  });
}
/** Completed private native user-gesture navigation; the JS edge is never an HTTP redirect. */
export function nativeGestureNavigations(report, isPublic = publicEvidenceUrl) {
  const valid=value=>typeof value==='string'&&norm(value)===value&&Boolean(isPublic(value));
  const keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().join(','):'';
  const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
  const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(Date.parse(value)).toISOString()===value;
  const started=Date.parse(report?.startedAt),finished=report?.finishedAt===undefined?Date.now()+5000:Date.parse(report.finishedAt);
  const entries=rows(report?.nativeGestureNavigations,2),seenEntries=new Set();
  return entries.filter(row=>{
    if(keys(row)!=='completedAt,documentHash,finalDocumentHash,finalStatus,finalUrl,href,kind,label,observedAt,pageUrl,redirects,targetUrl,text'||
      row.kind!=='NATIVE_GESTURE_SOURCE_OPEN'||row.finalStatus!==200||![row.pageUrl,row.href,row.targetUrl,row.finalUrl].every(valid)||
      typeof row.text!=='string'||typeof row.label!=='string'||row.text.length>160||row.label.length>160||
      row.text!==row.text.replace(/\s+/gu,' ').trim()||row.label!==row.label.replace(/\s+/gu,' ').trim()||
      !/\b(?:book|tee\s*times?|availability|calendar|bay|simulator)\b/iu.test(row.text+' '+row.label)||
      new URL(row.pageUrl).hash||row.href!==row.pageUrl+'#'||row.targetUrl===row.pageUrl||!sha(row.documentHash)||!sha(row.finalDocumentHash)||
      !stamp(row.observedAt)||!stamp(row.completedAt)||!Number.isFinite(started)||!Number.isFinite(finished)||Date.parse(row.observedAt)<started||
      Date.parse(row.completedAt)<Date.parse(row.observedAt)||Date.parse(row.completedAt)>finished||!Array.isArray(row.redirects)||row.redirects.length>5||
      !rows(report.officialLinkLedger,512).some(w=>w.kind==='NATIVE_VISIBLE_DOM'&&w.pageUrl===row.pageUrl&&w.observedAt===row.observedAt&&w.documentHash===row.documentHash&&
        rows(w.links,512).some(link=>link.href===row.href&&link.visible===true&&link.text===row.text&&link.label===row.label))||
      !rows(report.actions,256).some(a=>a.action?.method==='click'&&!a.error&&!a.actionError&&a.sourceUrl===row.pageUrl&&a.observedTarget?.tag==='A'&&
        a.observedTarget.href===row.href&&a.observedTarget.text?.replace(/\s+/gu,' ').trim()===row.text&&
        a.observedTarget.label?.replace(/\s+/gu,' ').trim()===row.label&&a.afterUrl===row.finalUrl&&a.openedNewPage===false)||
      !rows(report.visitedUrls,1024).includes(row.pageUrl)||!rows(report.visitedUrls,1024).includes(row.finalUrl))return false;
    const key=JSON.stringify([row.pageUrl,row.observedAt,row.documentHash,row.href]);if(seenEntries.has(key))return false;
    let current=row.targetUrl;const seen=new Set([current]);
    for(const hop of row.redirects){if(keys(hop)!=='completed,fromUrl,status,toUrl'||hop.completed!==true||![301,302,303,307,308].includes(hop.status)||
      hop.fromUrl!==current||!valid(hop.toUrl)||seen.has(hop.toUrl))return false;current=hop.toUrl;seen.add(current);}
    if(current!==row.finalUrl)return false;seenEntries.add(key);return true;
  });
}
export function nativeLinkSource(row) {
  if (row?.kind !== 'NATIVE_DOM_LINK_OBSERVED') return null;
  // v9 wrote url; v10 writes sourceUrl. Conflicting aliases never attest a source.
  if (row.sourceUrl !== undefined && row.url !== undefined && row.sourceUrl !== row.url) return null;
  return norm(row.sourceUrl ?? row.url);
}
export function nativeLinkActions(report) {
  return [...rows(report.actions, 256), ...rows(report.observedNavigationActions, 256)].filter(row =>
    (row.action?.method === 'click' || row.kind === 'PUBLIC_LINK_CLICK') && !row.error && !row.actionError &&
    String(row.observedTarget?.tag).toUpperCase() === 'A' && norm(row.sourceUrl) && norm(row.observedTarget?.href) && norm(row.afterUrl));
}
/** Routing only: correlate an actually clicked legacy tenant entry with its
 * freshly attested current native document. Never synthesize a destination or
 * treat an SDK afterUrl alone as redirect, identity or availability proof. */
export function nativeLegacyGatewayLandings(report, isPublic = publicEvidenceUrl) {
  const started=Date.parse(report?.startedAt),history=nativeHistoryNavigations(report,isPublic),seen=new Set(),result=[];
  if(!Number.isFinite(started))return result;
  for(const action of nativeLinkActions(report)){
    const href=norm(action.observedTarget.href),after=norm(action.afterUrl),source=norm(action.sourceUrl);
    if(!isEzLinksLegacyGateway(href)||!source||!after||!isPublic(source)||!isPublic(after)||
      /\b(?:member|members|preferred|account|sign.?in|log.?in)\b/iu.test([action.observedTarget.text,action.observedTarget.label,action.observedTarget.rowText].filter(Boolean).join(' ')))continue;
    const legacy=new URL(href),landing=new URL(after),tenant=legacy.hostname.slice(0,-'.ezlinks.com'.length);
    if(landing.hostname!==tenant+'.ezlinksgolf.com'||landing.protocol!=='https:'||landing.username||landing.password||landing.port||landing.search||landing.hash||!['/','/search'].includes(landing.pathname))continue;
    const route=history.find(row=>(row.documentUrl===after||row.finalUrl===after)&&new URL(row.documentUrl).origin===landing.origin&&new URL(row.documentUrl).pathname==='/');
    if(!route||!rows(report.officialLinkLedger,512).some(row=>row.kind==='NATIVE_VISIBLE_DOM'&&row.pageUrl===source&&/^[a-f0-9]{64}$/u.test(row.documentHash??'')&&
      Number.isFinite(Date.parse(row.observedAt))&&Date.parse(row.observedAt)>=started&&Date.parse(row.observedAt)<=Date.parse(route.observedAt)&&
      rows(row.links,512).some(link=>link.href===href&&link.visible===true)))continue;
    const key=JSON.stringify([href,route.documentUrl,route.finalUrl]);if(seen.has(key))continue;seen.add(key);
    result.push({sourceUrl:source,href,documentUrl:route.documentUrl,finalUrl:route.finalUrl});if(result.length===4)break;
  }
  return result;
}
export function corroboratedNativeLink(row, target, report) {
  const source = nativeLinkSource(row), href = norm(target);
  return Boolean(source && href && nativeLinkActions(report).some(action =>
    norm(action.sourceUrl) === source && norm(action.observedTarget.href) === href));
}
/** Exact, officially reachable clicked ancestors. A changed query never gains an edge. */
export function observedBookingSourceCandidates(report, officialUrl, isPublic = publicEvidenceUrl, { sourceDiscoveryOnly = false } = {}) {
  const valid = value => Boolean(norm(value) && isPublic(value));
  if (!valid(officialUrl)) return [];
  const official = norm(officialUrl), observed = new Set(), edges = new Map();
  let edgeCount = 0;
  const intermediaryEntries = sourceDiscoveryOnly ? nativeIntermediaryNavigations(report,isPublic) : [];
  const historyEntries = sourceDiscoveryOnly ? nativeHistoryNavigations(report,isPublic) : [];
  const legacyLandings = sourceDiscoveryOnly ? nativeLegacyGatewayLandings(report,isPublic) : [];
  const see = value => { if (valid(value)) observed.add(norm(value)); };
  const link = (from, to) => {
    if (!valid(from) || !valid(to) || edgeCount >= 2048) return;
    const source = norm(from), target = norm(to);
    if (!edges.has(source)) edges.set(source, new Set());
    if (!edges.get(source).has(target)) { edges.get(source).add(target); edgeCount++; }
  };
  for (const value of rows(report.visitedUrls, 512)) see(value);
  for (const row of rows(report.officialLinkLedger, 512)) {
    if(row.kind==='NATIVE_PUBLIC_BOOKING_INTERMEDIARY'&&!intermediaryEntries.some(entry=>entry.pageUrl===row.pageUrl&&entry.observedAt===row.observedAt&&entry.documentHash===row.documentHash&&row.links?.length===1&&row.links[0].href===entry.url&&row.links[0].visible===false))continue;
    see(row.pageUrl);
    for (const item of rows(row.links, 512)) link(row.pageUrl, item.href);
  }
  for (const row of rows(report.frameLedger, 512))
    for (const frame of rows(row.frames, 32)) link(row.pageUrl, frame.src);
  for (const row of rows(report.observedSourceEvidence, 1024)) {
    if (row.kind === 'NETWORK_DOCUMENT') {
      if (row.completedAt && Number.isInteger(row.status) && row.status >= 200 && row.status < 400) {
        see(row.url);
        if (row.status >= 300) link(row.url, row.redirectTo);
      }
    } else if (['DOM_OBSERVED', 'FRAME_NAVIGATED'].includes(row.kind)) see(row.url);
    else if (row.kind === 'NATIVE_DOM_LINK_OBSERVED') see(nativeLinkSource(row));
    if (row.kind === 'DOM_OBSERVED' || row.kind === 'NATIVE_DOM_LINK_OBSERVED') {
      const source = row.kind === 'NATIVE_DOM_LINK_OBSERVED' ? nativeLinkSource(row) : row.url;
      for (const target of rows(row.exactObservedHrefs, 512))
        if (row.kind !== 'NATIVE_DOM_LINK_OBSERVED' || corroboratedNativeLink(row, target, report)) link(source, target);
      if (row.kind === 'DOM_OBSERVED') for (const target of rows(row.exactObservedFrameUrls, 32)) link(source, target);
    }
  }
  const initial = report.initialNavigation;
  if (initial?.requestedUrl === officialUrl && Number.isInteger(initial.status) && initial.status >= 200 && initial.status < 400 &&
      valid(initial.finalUrl) && observed.has(norm(initial.finalUrl))) link(officialUrl, initial.finalUrl);
  if(sourceDiscoveryOnly)for(const row of [...nativeFrameNavigations(report,isPublic),...nativeIntermediaryNavigations(report,isPublic),...nativeGestureNavigations(report,isPublic)]){
    see(row.finalUrl);if(row.kind==='NATIVE_GESTURE_SOURCE_OPEN'){see(row.targetUrl);link(row.pageUrl,row.targetUrl);}for(const hop of row.redirects){see(hop.fromUrl);see(hop.toUrl);link(hop.fromUrl,hop.toUrl);}
  }
  for(const row of legacyLandings)link(row.href,row.documentUrl);
  const reachable = new Set([official]);
  for(const entry of historyEntries){see(entry.finalUrl);link(entry.documentUrl,entry.finalUrl);}
  for (const source of reachable) for (const target of edges.get(source) ?? []) reachable.add(target);
  const output = [];
  const append = value => { if (!output.includes(value)) output.push(value); if (sourceDiscoveryOnly) assertSourceCandidateBudget(output); };
  const startup = new Set([official, ...(valid(initial?.finalUrl) ? [norm(initial.finalUrl)] : [])]);
  for (const action of nativeLinkActions(report).reverse()) {
    const source = norm(action.sourceUrl), href = norm(action.observedTarget.href), after = norm(action.afterUrl);
    if (sourceDiscoveryOnly && (startup.has(href) || href === source + '#')) continue;
    if (!valid(href) || !reachable.has(source) || !edges.get(source)?.has(href) || !observed.has(after) || after === source) continue;
    const anchor = new URL(href), landing = new URL(after);
    const bareLanding = !anchor.search && !anchor.hash && !landing.hash && anchor.origin === landing.origin && anchor.pathname === landing.pathname;
    // Hybrid proposes the exact observed/clicked ancestor, never a substituted
    // redirected landing. Fresh fixed inspection still owns source authority.
    if (!sourceDiscoveryOnly && href !== after && !bareLanding) continue;
    append(href);
    if (!sourceDiscoveryOnly && output.length === 32) break;
  }
  if(sourceDiscoveryOnly){
    for(const entry of historyEntries)if(reachable.has(entry.documentUrl)&&reachable.has(entry.finalUrl))append(entry.finalUrl);
    // A visible embedded source is observed routing, never availability proof.
    const frames=[...rows(report.frameLedger,512).flatMap(row=>rows(row.frames,32).filter(f=>f.visible===true).map(f=>({source:row.pageUrl,url:f.src}))),
      ...rows(report.observedSourceEvidence,1024).filter(row=>row.kind==='DOM_OBSERVED').flatMap(row=>rows(row.exactObservedVisibleFrameUrls,32).map(url=>({source:row.url,url})))];
    for(const frame of frames.reverse())if(valid(frame.url)&&reachable.has(norm(frame.source))&&edges.get(norm(frame.source))?.has(norm(frame.url))&&!startup.has(norm(frame.url))&&!output.includes(norm(frame.url))){
      append(norm(frame.url));
    }
    // A completed private native frame entry may expose an exact redirect
    // destination without that destination linking to itself. It remains only
    // unverified routing; fixed inspection must independently re-earn the path.
    for(const entry of nativeFrameNavigations(report,isPublic))if(reachable.has(norm(entry.pageUrl))&&
      edges.get(norm(entry.pageUrl))?.has(norm(entry.frameUrl))&&reachable.has(norm(entry.finalUrl))&&
      observed.has(norm(entry.finalUrl))&&!startup.has(norm(entry.finalUrl)))append(norm(entry.finalUrl));
    for(const entry of nativeGestureNavigations(report,isPublic))if(reachable.has(norm(entry.pageUrl))&&reachable.has(norm(entry.finalUrl))&&
      observed.has(norm(entry.finalUrl))&&!startup.has(norm(entry.finalUrl)))append(norm(entry.finalUrl));
    // Only the fixed synchronous DOM collector can emit this visible-link
    // observation. The exact same-attempt href is an unverified routing choice;
    // it is not a visited landing, provider identity, method, or inventory proof.
    const started = Date.parse(report.startedAt), finished = report.finishedAt === undefined ? Date.now() + 5000 : Date.parse(report.finishedAt);
    const fresh = row => row.kind === 'NATIVE_VISIBLE_DOM' && Number.isFinite(started) && Number.isFinite(finished) &&
      Number.isFinite(Date.parse(row.observedAt)) && Date.parse(row.observedAt) >= started && Date.parse(row.observedAt) <= finished;
    const visibleEdges = new Map();
    const visibleLink = (from,to) => { if(valid(from)&&valid(to)){const a=norm(from);if(!visibleEdges.has(a))visibleEdges.set(a,new Set());visibleEdges.get(a).add(norm(to));} };
    for(const row of rows(report.officialLinkLedger,512))if(fresh(row))for(const item of rows(row.links,512))if(item.visible===true)visibleLink(row.pageUrl,item.href);
    for(const row of rows(report.frameLedger,512))for(const frame of rows(row.frames,32))if(frame.visible===true)visibleLink(row.pageUrl,frame.src);
    for(const action of nativeLinkActions(report))if(edges.get(norm(action.sourceUrl))?.has(norm(action.observedTarget.href))&&observed.has(norm(action.afterUrl))){visibleLink(action.sourceUrl,action.observedTarget.href);visibleLink(action.observedTarget.href,action.afterUrl);}
    if(initial?.requestedUrl===officialUrl&&Number.isInteger(initial.status)&&initial.status>=200&&initial.status<400&&observed.has(norm(initial.finalUrl)))visibleLink(officialUrl,initial.finalUrl);
    for(const row of nativeFrameNavigations(report,isPublic))for(const hop of row.redirects)visibleLink(hop.fromUrl,hop.toUrl);
    // A distinct fixed-native raw public document edge can reach the next
    // document; it never converts the hidden anchor into visible evidence.
    for(const row of nativeIntermediaryNavigations(report,isPublic)){visibleLink(row.pageUrl,row.url);for(const hop of row.redirects)visibleLink(hop.fromUrl,hop.toUrl);}
    for(const row of nativeGestureNavigations(report,isPublic)){visibleLink(row.pageUrl,row.targetUrl);for(const hop of row.redirects)visibleLink(hop.fromUrl,hop.toUrl);}
    for(const row of historyEntries)visibleLink(row.documentUrl,row.finalUrl);
    for(const row of legacyLandings)visibleLink(row.href,row.documentUrl);
    const visibleReachable=new Set([official]);for(const from of visibleReachable)for(const to of visibleEdges.get(from)??[])visibleReachable.add(to);
    const documentKey=value=>{const url=new URL(value);return url.origin+url.pathname+url.search;};
    const startupDocuments=new Set([...startup].map(documentKey));
    for (const row of rows(report.officialLinkLedger, 512).reverse()) {
      const at = Date.parse(row.observedAt), page = norm(row.pageUrl);
      if (row.kind !== 'NATIVE_VISIBLE_DOM' || !Number.isFinite(started) || !Number.isFinite(finished) || !Number.isFinite(at) ||
          at < started || at > finished || !observed.has(page) || !visibleReachable.has(page)) continue;
      for (const item of rows(row.links, 512)) {
        const href = norm(item.href);
        if (item.visible === true && valid(href) && !startupDocuments.has(documentKey(href)) && edges.get(page)?.has(href)) append(href);
      }
    }
  }
  if (!sourceDiscoveryOnly && output.length < 32 && observed.has(official) && !output.includes(official)) output.push(official);
  return output;
}
