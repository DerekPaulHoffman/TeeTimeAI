import type { OfficialIdentityPage } from "./teeitup-official-identity";
import { deriveCpsRootEntry, registerCpsOfficialEntryContext, type CpsOfficialEntryContext } from "./cps-official-entry-proof";
import { registerFreshNativeDelegatedDocument } from "./native-official-page-attestation";
import { readNativeOfficialIdentityPage, type NativeOfficialPageReader } from "./native-official-page-reader";
import { createCourseDiscoveryBrowserSession } from "./browser-session";

type Session = Pick<Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>>, "execute" | "readDelegatedSourceDocument" | "close">;
export type CpsEntryReaderDependencies = {
  requestLease?: <T>(family: string, work: () => Promise<T>) => Promise<{ acquired: true; value: T } | { acquired: false }>;
  readRoot?: NativeOfficialPageReader;
  createSession?: (input: Parameters<typeof createCourseDiscoveryBrowserSession>[0], deps: Parameters<typeof createCourseDiscoveryBrowserSession>[1]) => Promise<Session>;
};
/** Exactly the current root's sole visible ordinary booking link, then one
 * public document. No form submission, provider route guessing or hidden href. */
export async function readCpsOfficialEntry(source: CpsOfficialEntryContext["source"], canonicalPhone: string, deadlineAt: Date,
  deps: CpsEntryReaderDependencies = {}, retainedRoot?: OfficialIdentityPage): Promise<CpsOfficialEntryContext> {
  const deadline = new Date(Math.min(deadlineAt.getTime(), Date.now() + 30_000));
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) throw new Error("CPS_OFFICIAL_ENTRY_UNVERIFIED");
  const requestLease = deps.requestLease ? async <T>(family: string, work: () => Promise<T>) => {
    const result = await deps.requestLease!(family, work); return result.acquired ? { acquired: true as const, value: await result.value } : { acquired: false as const };
  } : undefined;
  const root = retainedRoot ?? (deps.readRoot ? await deps.readRoot(source, source.officialUrl, deadline, "PHONE_LINK") :
    await readNativeOfficialIdentityPage(source, source.officialUrl, deadline, { requestLease, allowCpsPhoneBookingContact: true,
      collectPublicCourseContacts: true, trustedContext: { canonicalCoursePhone: canonicalPhone } }));
  const target = deriveCpsRootEntry(source, root, canonicalPhone).bookingDocumentUrl;
  const session = await (deps.createSession ?? createCourseDiscoveryBrowserSession)({ initialUrls: [target], venueOfficialUrl: source.officialUrl,
    venueName: source.venueName, venueAddress: source.venueAddress, timeZone: source.timeZone, deadlineAt: deadline,
    trustedContext: { canonicalCoursePhone: canonicalPhone } }, { browserTransport: "NATIVE_CHROME", captureDelegatedDocument: true, requestLease });
  try {
    const snapshot = await session.execute({ id: 1, action: "open", url: target });
    if (snapshot.url !== target || snapshot.navigationStatus !== 200 || snapshot.browserTransport !== "NATIVE_CHROME" ||
        snapshot.accessRequirementObserved || snapshot.nativeFirstFatal) throw new Error("CPS_OFFICIAL_ENTRY_UNVERIFIED");
    const entry = await session.readDelegatedSourceDocument();
    if (entry.url !== target || entry.browserTransport !== "NATIVE_CHROME" || Date.now() >= deadline.getTime()) throw new Error("CPS_OFFICIAL_ENTRY_UNVERIFIED");
    registerFreshNativeDelegatedDocument(entry, source.officialUrl, deadline);
    return registerCpsOfficialEntryContext(source, root, entry, canonicalPhone);
  } finally { await session.close(); }
}
