// Fixed collector provenance only. This module performs no I/O or navigation.
import { publicEvidenceUrl } from './public-evidence.mjs';
const rows = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : [];
const norm = value => publicEvidenceUrl(value);
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
  const see = value => { if (valid(value)) observed.add(norm(value)); };
  const link = (from, to) => {
    if (!valid(from) || !valid(to) || edgeCount >= 2048) return;
    const source = norm(from), target = norm(to);
    if (!edges.has(source)) edges.set(source, new Set());
    if (!edges.get(source).has(target)) { edges.get(source).add(target); edgeCount++; }
  };
  for (const value of rows(report.visitedUrls, 512)) see(value);
  for (const row of rows(report.officialLinkLedger, 512)) {
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
  const reachable = new Set([official]);
  for (const source of reachable) for (const target of edges.get(source) ?? []) reachable.add(target);
  const output = [];
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
    if (!output.includes(href)) output.push(href);
    if (output.length === 32) break;
  }
  if(sourceDiscoveryOnly){
    // A visible embedded source is observed routing, never availability proof.
    const frames=[...rows(report.frameLedger,512).flatMap(row=>rows(row.frames,32).filter(f=>f.visible===true).map(f=>({source:row.pageUrl,url:f.src}))),
      ...rows(report.observedSourceEvidence,1024).filter(row=>row.kind==='DOM_OBSERVED').flatMap(row=>rows(row.exactObservedVisibleFrameUrls,32).map(url=>({source:row.url,url})))];
    for(const frame of frames.reverse())if(valid(frame.url)&&reachable.has(norm(frame.source))&&edges.get(norm(frame.source))?.has(norm(frame.url))&&!startup.has(norm(frame.url))&&!output.includes(norm(frame.url))){
      output.push(norm(frame.url));if(output.length===32)break;
    }
  }
  if (!sourceDiscoveryOnly && output.length < 32 && observed.has(official) && !output.includes(official)) output.push(official);
  return output;
}
