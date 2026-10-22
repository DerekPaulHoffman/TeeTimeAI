import { isTeeItUpPlayEntry, publicDocumentUrl, readTeeItUpOfficialEmbed, readTeeItUpOfficialHome, sameTeeItUpOfficialHost,
  teeItUpBookAlias, type TeeItUpObservedSourceChain, type TeeItUpSourceIdentity } from "./teeitup-official-booking-source";
import type { OfficialIdentityPage } from "./teeitup-official-identity";

declare const requestBrand: unique symbol;
declare const chainBrand: unique symbol;
export type TeeItUpSourceRequestToken = object & { readonly [requestBrand]: true };
export type TeeItUpOfficialBookingToken = object & { readonly [chainBrand]: true };
type Record = { object: object; token: TeeItUpSourceRequestToken; parent?: object; url: string; order: number; epoch: number;
  status?: number; location?: string; timeOrigin?: number; html?: boolean };
const chains = new WeakMap<TeeItUpOfficialBookingToken, { live: () => boolean; chain: TeeItUpObservedSourceChain }>();
const redirects = new Set([301, 302, 303, 307, 308]);
export function observedTeeItUpOfficialBookingChain(token: TeeItUpOfficialBookingToken): TeeItUpObservedSourceChain {
  const value = chains.get(token);
  if (!value?.live()) throw new Error("OFFICIAL_BOOKING_SOURCE_UNVERIFIED");
  return { ...value.chain };
}

/** Controller-local exact object lineage. No JSON value or URL membership can
 * recreate request tokens, a completed edge or initial rendered visibility. */
export function createTeeItUpOfficialBookingScope(source: TeeItUpSourceIdentity, signal: AbortSignal) {
  let active = true, epoch = 0, sequence = 0, current: Record | undefined;
  let records = new WeakMap<object, Record>(), tokens = new WeakMap<TeeItUpSourceRequestToken, Record>();
  let home: { record: Record; value: ReturnType<typeof readTeeItUpOfficialHome> } | undefined;
  let page: { record: Record; value: ReturnType<typeof readTeeItUpOfficialEmbed> } | undefined;
  let finalSnapshot: { epoch: number; url: string; record: Record } | undefined;
  function reset() { epoch++; sequence = 0; current = undefined; records = new WeakMap(); tokens = new WeakMap(); home = undefined; page = undefined; finalSnapshot = undefined; }
  function invalidate() { reset(); }
  signal.addEventListener("abort", invalidate, { once: true });
  return {
    checkCurrentDocument(url: string, timeOrigin?: number) {
      if (current && (current.url !== url || timeOrigin !== undefined && current.timeOrigin !== undefined && current.timeOrigin !== timeOrigin)) reset();
    },
    beginMainDocument(object: object, input: { url: string; method: string; parent?: object }): TeeItUpSourceRequestToken | undefined {
      if (!active || signal.aborted || input.method !== "GET" || !publicDocumentUrl(input.url)) { reset(); return; }
      if (input.url === source.officialUrl || home && input.url === home.record.url) reset();
      epoch++; finalSnapshot = undefined;
      if (++sequence > 8) { reset(); return; }
      const token = Object.freeze({}) as TeeItUpSourceRequestToken;
      const record: Record = { object, token, ...input, order: sequence, epoch };
      records.set(object, record); tokens.set(token, record); current = record;
      return token;
    },
    completeMainDocument(token: TeeItUpSourceRequestToken, reply: { status: number; location?: string; contentType?: string }) {
      const record = tokens.get(token);
      if (!active || signal.aborted || !record || record.status !== undefined) return;
      if (reply.status !== 200 && !redirects.has(reply.status)) { reset(); return; }
      record.status = reply.status;
      record.html = /^text\/html(?:;|$)/iu.test(reply.contentType ?? "");
      if (reply.location !== undefined) {
        try { record.location = new URL(reply.location, record.url).href; } catch { reset(); }
      }
    },
    observeRenderedSnapshot(token: TeeItUpSourceRequestToken | undefined, input: { url: string; timeOrigin: number;
      officialPage?: OfficialIdentityPage; verifiedOfficial?: { kind: "VERIFIED_OFFICIAL_DOCUMENT"; officialUrl: string; documentUrl: string };
      frames: string[]; blocked: boolean }) {
      if (!active || signal.aborted) return;
      const record = token && tokens.get(token);
      if (!record || record !== current || record.status !== 200 || !record.html || record.url !== input.url || input.blocked ||
          !Number.isFinite(input.timeOrigin) || record.timeOrigin !== undefined && record.timeOrigin !== input.timeOrigin) { reset(); return; }
      record.timeOrigin = input.timeOrigin;
      if (input.officialPage && input.verifiedOfficial && input.verifiedOfficial.officialUrl === source.officialUrl && input.verifiedOfficial.documentUrl === input.url) {
        if (!home) {
          const root = source.officialUrl && publicDocumentUrl(source.officialUrl), actual = publicDocumentUrl(input.url);
          const parent = record.parent && records.get(record.parent);
          const exactRoot = record.url === source.officialUrl && record.order === 1;
          const aliasRoot = root && actual && record.order === 2 && parent?.order === 1 && parent.url === source.officialUrl &&
            parent.status !== undefined && redirects.has(parent.status) && parent.location === record.url &&
            sameTeeItUpOfficialHost(root.href, actual.href) && root.pathname === actual.pathname && root.search === actual.search;
          if (!exactRoot && !aliasRoot) return;
          try { home = { record, value: readTeeItUpOfficialHome(source, input.officialPage, true) }; } catch { return; }
        } else if (record.order === home.record.order + 1 && input.url === home.value.bookingPageUrl) {
          try { page = { record, value: readTeeItUpOfficialEmbed(input.officialPage, input.frames) }; } catch { page = undefined; }
        }
      }
      if (teeItUpBookAlias(input.url)) finalSnapshot = { epoch, url: input.url, record };
    },
    tokenFor(bookingUrl: string, currentUrl: string): TeeItUpOfficialBookingToken | undefined {
      if (!active || signal.aborted || !home || !page || !finalSnapshot || finalSnapshot.epoch !== epoch || finalSnapshot.url !== bookingUrl || currentUrl !== bookingUrl ||
          !source.officialUrl || !teeItUpBookAlias(bookingUrl)) return;
      const final = finalSnapshot.record, entry = final.parent && records.get(final.parent);
      if (!entry || entry.url !== page.value.iframeEntryUrl || !isTeeItUpPlayEntry(entry.url) || entry.order !== page.record.order + 1 ||
          final.order !== entry.order + 1 || entry.status === undefined || !redirects.has(entry.status) || entry.location !== bookingUrl || final.status !== 200) return;
      const chain: TeeItUpObservedSourceChain = { officialUrl: source.officialUrl, officialDocumentUrl: home.record.url,
        bookingPageUrl: page.record.url, iframeEntryUrl: entry.url, bookingSourceUrl: bookingUrl,
        homeWitnessSha256: home.value.witness, pageWitnessSha256: page.value.witness,
        iframeRedirectStatus: entry.status as TeeItUpObservedSourceChain["iframeRedirectStatus"] };
      const observedEpoch = epoch;
      const token = Object.freeze({}) as TeeItUpOfficialBookingToken;
      chains.set(token, { chain, live: () => active && !signal.aborted && epoch === observedEpoch && current === final && finalSnapshot?.record === final });
      return token;
    },
    invalidate,
    close() { active = false; reset(); signal.removeEventListener("abort", invalidate); },
  };
}
