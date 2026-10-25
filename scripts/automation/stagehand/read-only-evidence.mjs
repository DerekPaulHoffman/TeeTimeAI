// Passive, bounded public observation only. No request or application mutation.
export function installReadOnlyEvidence() {
  if (globalThis.__ttsFrameworkReadEvidence) return;
  const sensitive = /password|secret|token|cookie|session|credential|authorization|api.?key|email|phone|customer|contact|attendee|payment|card|profile|account|member|user/iu;
  const ledger = { requests: [], responseBytes: 0, dropped: 0, droppedByReason: {}, bodyOmittedByReason: {} };
  Object.defineProperty(globalThis, '__ttsFrameworkReadEvidence', { value: ledger, configurable: false });
  const count = (bucket, reason) => { bucket[reason] = Math.min((bucket[reason] ?? 0) + 1, 1000000); };
  const publicRoutingInteger = value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 2147483647 || typeof value === 'string' && /^(?:0|[1-9][0-9]{0,9})$/u.test(value) && Number(value) <= 2147483647;
  let truncations = 0;
  const safeUrl = value => {
    try {
      const url = new URL(value, location.href);
      if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.port || !url.hostname.includes('.') ||
          /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname) || /^\d+(?:\.\d+){3}$/u.test(url.hostname) || url.href.length > 2048) return { reason: 'INVALID_PUBLIC_URL' };
      for (const [key, item] of url.searchParams) {
        // This public integer identifies a store, never a golfer or credential.
        const routingInteger = key === 'memberStoreId' && url.searchParams.getAll(key).length === 1 && publicRoutingInteger(item);
        if (sensitive.test(key) && !routingInteger) return { reason: 'SENSITIVE_QUERY' };
      }
      return { url: url.href };
    } catch { return { reason: 'INVALID_PUBLIC_URL' }; }
  };
  Object.defineProperty(globalThis, '__ttsSafePublicEvidenceUrl', { value: value => safeUrl(value).url ?? null, configurable: false });
  const scrub = (value, depth = 0) => {
    if (depth > 6) { truncations++; return '[DEPTH_LIMIT]'; }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (value.length > 800) truncations++;
      return value.replace(/https?:\/\/[^\s"<>]+/gu, candidate => safeUrl(candidate).url ? candidate : '[REDACTED_URL]')
        .replace(/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]+|[^\s@]+@[^\s@]+\.[^\s@]+|eyJ[A-Za-z0-9_-]{20,})/gu, '[REDACTED]').slice(0, 800);
    }
    if (Array.isArray(value)) { if (value.length > 120) truncations++; return value.slice(0, 120).map(item => scrub(item, depth + 1)); }
    if (typeof value === 'object') {
      const entries = Object.entries(value).filter(([key, item]) => key === 'memberStoreId' && publicRoutingInteger(item) || !sensitive.test(key));
      if (entries.length > 80) truncations++;
      return Object.fromEntries(entries.slice(0, 80).map(([key, item]) => [key, scrub(item, depth + 1)]));
    }
    return null;
  };
  const add = async (urlValue, method, status, bodyText, requestBody = null) => {
    const classified = safeUrl(urlValue);
    if (!classified.url || ledger.requests.length >= 96) { ledger.dropped++; count(ledger.droppedByReason, classified.reason ?? 'ROW_LIMIT'); return; }
    const url = classified.url;
    let body = null;
    let request = null;
    const beforeRequest = truncations;
    if (typeof requestBody === 'string' && requestBody.length <= 8192) { try { request = scrub(JSON.parse(requestBody)); } catch {} }
    const requestTruncated = truncations > beforeRequest;
    const beforeBody = truncations;
    if (typeof bodyText === 'string') {
      if (bodyText.length > 131072) count(ledger.bodyOmittedByReason, 'BODY_LIMIT');
      else if (ledger.responseBytes + bodyText.length > 524288) count(ledger.bodyOmittedByReason, 'BYTE_BUDGET');
      else { try { body = scrub(JSON.parse(bodyText)); ledger.responseBytes += bodyText.length; } catch { count(ledger.bodyOmittedByReason, 'INVALID_JSON'); } }
    }
    ledger.requests.push({ url, method: String(method).toUpperCase(), status, request, body,
      ...(requestTruncated ? { requestTruncated: true } : {}), ...(truncations > beforeBody ? { bodyTruncated: true } : {}) });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function(input, init) {
    const response = await originalFetch.apply(this, arguments);
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (response.headers.get('content-type')?.includes('json')) response.clone().text().then(text => add(url, init?.method ?? input?.method ?? 'GET', response.status, text, init?.body)).catch(() => {});
    else add(url, init?.method ?? input?.method ?? 'GET', response.status, null).catch(() => {});
    return response;
  };
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const state = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url) { state.set(this, { method, url }); return originalOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(body) {
    const info = state.get(this);
    this.addEventListener('loadend', () => { if (!info) return; let text = null; try { if (this.getResponseHeader('content-type')?.includes('json') && ['', 'text'].includes(this.responseType)) text = this.responseText; } catch {} add(this.responseURL || info.url, info.method, this.status, text, body).catch(() => {}); }, { once: true });
    return originalSend.apply(this, arguments);
  };
}
