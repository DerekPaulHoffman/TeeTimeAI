// Fixed collector provenance only. This module performs no I/O or navigation.
import { publicEvidenceUrl } from './public-evidence.mjs';
export const SOURCE_CANDIDATE_LIMIT = 160;
export const SOURCE_CANDIDATE_URL_BYTES = 65536;
export function assertSourceCandidateBudget(candidates) {
  if (!Array.isArray(candidates) || candidates.length > SOURCE_CANDIDATE_LIMIT ||
      candidates.reduce((bytes, value) => bytes + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : SOURCE_CANDIDATE_URL_BYTES + 1), 0) > SOURCE_CANDIDATE_URL_BYTES)
    throw new Error('FRAMEWORK_SOURCE_CANDIDATES_LIMIT');
  return candidates;
}
const rows = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
const norm = value => publicEvidenceUrl(value);
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
  if(sourceDiscoveryOnly)for(const row of [...nativeFrameNavigations(report,isPublic),...nativeIntermediaryNavigations(report,isPublic)]){
    see(row.finalUrl);for(const hop of row.redirects){see(hop.fromUrl);see(hop.toUrl);link(hop.fromUrl,hop.toUrl);}
  }
  const reachable = new Set([official]);
  for (const source of reachable) for (const target of edges.get(source) ?? []) reachable.add(target);
  const output = [];
  const append = value => { if (!output.includes(value)) output.push(value); if (sourceDiscoveryOnly) assertSourceCandidateBudget(output); };
  const startup = new Set([official, ...(valid(initial?.finalUrl) ? [norm(initial.finalUrl)] : [])]);
  for (const action of nativeLinkActions(report).reverse()) {
    const source = norm(action.sourceUrl), href = norm(action.observedTarget.href), after = norm(action.afterUrl);
    if (sourceDiscoveryOnly && startup.has(href)) continue;
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
    // A visible embedded source is observed routing, never availability proof.
    const frames=[...rows(report.frameLedger,512).flatMap(row=>rows(row.frames,32).filter(f=>f.visible===true).map(f=>({source:row.pageUrl,url:f.src}))),
      ...rows(report.observedSourceEvidence,1024).filter(row=>row.kind==='DOM_OBSERVED').flatMap(row=>rows(row.exactObservedVisibleFrameUrls,32).map(url=>({source:row.url,url})))];
    for(const frame of frames.reverse())if(valid(frame.url)&&reachable.has(norm(frame.source))&&edges.get(norm(frame.source))?.has(norm(frame.url))&&!startup.has(norm(frame.url))&&!output.includes(norm(frame.url))){
      append(norm(frame.url));
    }
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
