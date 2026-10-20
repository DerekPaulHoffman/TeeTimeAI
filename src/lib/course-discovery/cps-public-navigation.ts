/** CPS's legacy public landing creates a fresh ASP.NET cookieless session.
 * Only the canonical public landing is persisted. Session tokens remain inside
 * the newly created anonymous browser context and never grant URL authority. */
function parts(value: string) {
  try {
    const url = new URL(value);
    if (value.length > 2048 || url.protocol !== "https:" || url.hostname !== "sc.cps.golf" || url.username || url.password || url.port) return null;
    const path = /^\/([A-Za-z][A-Za-z0-9_-]{0,63})\/(?:\(S\(([a-z0-9]{24})\)\)\/)?(.+)$/u.exec(url.pathname);
    if (!path) return null;
    return { url, tenant: path[1], session: path[2], tail: path[3] };
  } catch { return null; }
}
export function cpsSessionKey(value: string) {
  const parsed = parts(value);
  return parsed?.session ? `${parsed.tenant}:${parsed.session}` : null;
}
export function hasCpsSessionState(value: string) {
  try { const url = new URL(value); return url.hostname === "sc.cps.golf" && /\/\(S\(/iu.test(decodeURIComponent(url.pathname)); }
  catch { return false; }
}
export function canonicalCpsPublicUrl(value: string) {
  const parsed = parts(value);
  if (!parsed?.session) return value;
  parsed.url.pathname = `/${parsed.tenant}/${parsed.tail}`;
  return parsed.url.href;
}
export function cpsPublicEntryUrl(value: string) {
  const parsed = parts(value);
  if (!parsed || !/^Home\/(?:nIndex|Index)\/?$/u.test(parsed.tail) || parsed.url.hash && parsed.url.hash !== "#") return null;
  const entries = [...parsed.url.searchParams];
  if (new Set(entries.map(([key]) => key)).size !== entries.length || entries.some(([key, item]) => {
    if (key === "CourseId") return !/^[1-9]\d{0,9}$/u.test(item) || Number(item) > 2_147_483_647;
    if (key === "Date") return !/^\d{4}-\d{2}-\d{2}$/u.test(item) || !Number.isFinite(Date.parse(`${item}T00:00:00Z`)) || new Date(`${item}T00:00:00Z`).toISOString().slice(0, 10) !== item;
    if (key === "Time") return !/^(?:AnyTime|Any|All)$/u.test(item);
    if (key === "Player") return !/^(?:[1-4]|99)$/u.test(item);
    if (key === "Hole") return !/^(?:Any|9|18)$/u.test(item);
    return true;
  }) || !parsed.url.searchParams.has("CourseId")) return null;
  parsed.url.pathname = `/${parsed.tenant}/${parsed.tail}`;
  parsed.url.hash = "";
  parsed.url.searchParams.delete("Date");
  return parsed.url.href;
}
function entryKey(value: string) {
  const entry = cpsPublicEntryUrl(value);
  if (!entry) return null;
  const url = new URL(entry);
  return `${url.origin}${url.pathname.replace(/\/$/u, "")}?CourseId=${url.searchParams.get("CourseId")}`;
}
export function createCpsPublicSessionScope(initialEntries: string[] = []) {
  const entries = new Set(initialEntries.map(entryKey).filter((value): value is string => Boolean(value)));
  const sessions = new Map<string, string>();
  return {
    observeEntry(value: string) { const key = entryKey(value); if (key && !cpsSessionKey(value)) entries.add(key); },
    authorize(value: string, redirectFrom?: string | null) {
      const session = cpsSessionKey(value);
      if (!session) return true;
      const currentEntry = entryKey(value);
      if (sessions.has(session)) return !currentEntry || currentEntry === sessions.get(session);
      const next = entryKey(value), previous = redirectFrom ? entryKey(redirectFrom) : null;
      const previousSession = redirectFrom ? cpsSessionKey(redirectFrom) : null;
      if (!next || next !== previous || !entries.has(next) || previousSession && !sessions.has(previousSession)) return false;
      sessions.set(session, next); return true;
    },
  };
}
