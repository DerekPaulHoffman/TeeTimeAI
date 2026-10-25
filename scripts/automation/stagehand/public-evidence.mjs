// Whole-object bounded projection for model prompts; never navigation authority.
const privateName = /password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|customer|contact|attendee|payment|card|profile|account|member|user|headers?/iu;
const routingInteger = value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647 || typeof value === 'string' && /^(?:0|[1-9][0-9]{0,9})$/u.test(value) && Number(value) <= 2147483647;
export function publicEvidenceUrl(value) {
  try {
    if (typeof value !== 'string' || value.length > 2048) return null;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !url.hostname.includes('.') ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname) || /^\d+(?:\.\d+){3}$/u.test(url.hostname)) return null;
    for (const [name, item] of url.searchParams)
      if (privateName.test(name) && !(name === 'memberStoreId' && url.searchParams.getAll(name).length === 1 && routingInteger(item))) return null;
    return url.href;
  } catch { return null; }
}

export function prioritizedPublicEvidence(evidence, { maxCharacters = 60000, includeDom = true } = {}) {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 5000 || maxCharacters > 120000) throw new Error('PUBLIC_EVIDENCE_BUDGET_INVALID');
  const flags = { truncated: false, networkInputRows: Array.isArray(evidence?.network?.requests) ? evidence.network.requests.length : 0,
    networkRowsOmitted: 0, networkBodiesOmitted: 0, domRowsOmitted: 0, privateFieldsRedacted: false };
  let truncations = 0;
  const markTruncated = () => { flags.truncated = true; truncations++; };
  const scrub = (value, depth = 0) => {
    if (depth > 8) { markTruncated(); return '[OMITTED_DEPTH]'; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (value.length > 12000) { markTruncated(); return '[OMITTED_LONG_STRING]'; }
      const cleaned = value.replace(/https?:\/\/[^\s"<>]+/gu, url => publicEvidenceUrl(url) ? url : '[REDACTED_URL]')
        .replace(/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+|[^\s@]+@[^\s@]+\.[^\s@]+|eyJ[A-Za-z0-9_-]{20,})/gu, '[REDACTED]');
      if (cleaned !== value) flags.privateFieldsRedacted = true;
      return cleaned;
    }
    if (Array.isArray(value)) {
      if (value.length > 500) markTruncated();
      return value.slice(0, 500).map(item => scrub(item, depth + 1));
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value); if (entries.length > 150) markTruncated();
      return Object.fromEntries(entries.slice(0, 150).filter(([name, item]) => {
        const keep = !privateName.test(name) || name === 'memberStoreId' && routingInteger(item);
        if (!keep) flags.privateFieldsRedacted = true;
        return keep;
      }).map(([name, item]) => [name, scrub(item, depth + 1)]));
    }
    return null;
  };
  const counts = value => value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([name, count]) =>
    /^[A-Z_]{1,50}$/u.test(name) && Number.isSafeInteger(count) && count >= 0 && count <= 1000000).slice(0, 20)) : {};
  const output = { url: publicEvidenceUrl(evidence?.url), publicControls: [], network: { requests: [],
    dropped: Number.isSafeInteger(evidence?.network?.dropped) ? evidence.network.dropped : 0,
    droppedByReason: counts(evidence?.network?.droppedByReason), bodyOmittedByReason: counts(evidence?.network?.bodyOmittedByReason) },
    evidenceProjection: flags, dom: [], links: [], frames: [] };
  const fits = () => JSON.stringify(output).length <= maxCharacters - 500;
  const append = (array, item) => { array.push(item); if (fits()) return true; array.pop(); flags.truncated = true; return false; };
  for (const control of (evidence?.publicControls ?? []).slice(0, 80)) {
    if (privateName.test(`${control.id ?? ''} ${control.name ?? ''} ${control.type ?? ''}`)) { flags.privateFieldsRedacted = true; continue; }
    const allowed = Object.fromEntries(['tag', 'id', 'name', 'type', 'value', 'selectedLabel', 'options'].filter(name => Object.hasOwn(control, name)).map(name => [name, control[name]]));
    const copy = scrub(allowed);
    if (JSON.stringify(output.publicControls).length + JSON.stringify(copy).length > Math.min(12000, maxCharacters / 5)) {
      flags.truncated = true; delete copy.options; copy.optionsOmitted = true;
    }
    if (!append(output.publicControls, copy)) break;
  }
  const source = (evidence?.network?.requests ?? []).slice(-96).reverse();
  const hasBody = row => row?.body !== null && row?.body !== undefined && row.status >= 200 && row.status < 400;
  const ordered = [...source.filter(row => hasBody(row) && row.bodyTruncated !== true),
    ...source.filter(row => hasBody(row) && row.bodyTruncated === true), ...source.filter(row => !hasBody(row))];
  for (const row of ordered) {
    const url = publicEvidenceUrl(row?.url);
    if (!url || output.network.requests.length >= 24) { flags.networkRowsOmitted++; flags.truncated = true; continue; }
    const metadata = { url, method: ['GET', 'POST', 'HEAD', 'OPTIONS'].includes(row.method) ? row.method : 'UNKNOWN', status: Number.isInteger(row.status) ? row.status : null };
    const before = truncations;
    const copy = { ...metadata, request: scrub(row.request), body: scrub(row.body) };
    if (truncations > before || row.bodyTruncated === true) copy.bodyTruncated = true;
    if (row.requestTruncated === true) copy.requestTruncated = true;
    if (!append(output.network.requests, copy)) {
      flags.networkBodiesOmitted++;
      if (!append(output.network.requests, { ...metadata, body: null, bodyOmittedReason: 'PROMPT_BUDGET' })) flags.networkRowsOmitted++;
    }
  }
  if (includeDom) for (const row of evidence?.dom ?? []) {
    const copy = scrub(Object.fromEntries(['tag', 'id', 'class', 'text', 'attributes'].filter(name => Object.hasOwn(row, name)).map(name => [name, row[name]])));
    if (!append(output.dom, copy)) { flags.domRowsOmitted = (evidence.dom?.length ?? 0) - output.dom.length; break; }
  }
  for (const row of (evidence?.links ?? []).slice(0, 80)) {
    const href = publicEvidenceUrl(row.href); if (href && !append(output.links, { href, text: scrub(row.text) })) break;
  }
  for (const row of (evidence?.frames ?? []).slice(0, 16)) {
    const src = publicEvidenceUrl(row.src); if (src && !append(output.frames, { src, title: scrub(row.title) })) break;
  }
  return output;
}
