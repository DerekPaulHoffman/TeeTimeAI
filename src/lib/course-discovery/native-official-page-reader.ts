import type { OfficialIdentityPage, OfficialIdentitySource } from "./teeitup-official-identity";
import { createCourseDiscoveryBrowserSession, type DiscoveryBrowserSessionDependencies, type DiscoveryBrowserSnapshot } from "./browser-session";
import { isSafeRecipeUrl } from "./recipe";
import { noteNativeOfficialIdentityPageCleanup, registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";
import { registerFreshNativeDelegatedDocument } from "./native-official-page-attestation";
import { consumeDelegatedGet, type DelegatedGetGrant, type DelegatedReadBudget } from "./teeitup-delegated-booking-context";
import type { DiscoveryTrustedContext } from "./trusted-context";

export type NativeOfficialPageReader = (source: OfficialIdentitySource, pageUrl: string, deadlineAt: Date,
  mode?: "POSTAL" | "PHONE_LINK") => Promise<OfficialIdentityPage>;
type Session = Pick<Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>>, "execute" | "readOfficialIdentityPage" | "close">;
type Dependencies = Pick<DiscoveryBrowserSessionDependencies, "requestLease" | "launchBrowser"> & {
  delegatedReadBudget?: DelegatedReadBudget;
  collectPublicCourseContacts?: true;
  allowCpsPhoneBookingContact?: true;
  allowTeeItUpContactChainRoot?: true;
  trustedContext?: DiscoveryTrustedContext;
  createSession?: (input: Parameters<typeof createCourseDiscoveryBrowserSession>[0], deps: DiscoveryBrowserSessionDependencies) => Promise<Session>;
};

/** Controller-owned fresh isolated public reader. No model navigation or provider
 * API routes enter this one-page contract; the shared native proxy guards all
 * network traffic and the browser session owns status/challenge/visibility. */
export async function readNativeOfficialIdentityPage(source: OfficialIdentitySource, pageUrl: string, deadlineAt: Date,
  deps: Dependencies = {}): Promise<OfficialIdentityPage> {
  if (!source.officialUrl || !isSafeRecipeUrl(pageUrl) || !isSafeRecipeUrl(source.officialUrl) ||
      new URL(pageUrl).origin !== new URL(source.officialUrl).origin) throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
  if (deps.allowTeeItUpContactChainRoot && pageUrl !== source.officialUrl) throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
  const deadline = new Date(Math.min(deadlineAt.getTime(), Date.now() + 30_000));
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) throw new Error("DEADLINE_EXCEEDED");
  const createSession = deps.createSession ?? createCourseDiscoveryBrowserSession;
  const session = await createSession({ deadlineAt: deadline, initialUrls: [pageUrl], venueName: source.venueName,
    venueAddress: source.venueAddress, venueOfficialUrl: source.officialUrl, timeZone: source.timeZone,
    ...(deps.trustedContext === undefined ? {} : { trustedContext: structuredClone(deps.trustedContext) }) },
  { requestLease: deps.requestLease, launchBrowser: deps.launchBrowser, browserTransport: "NATIVE_CHROME",
    ...(deps.delegatedReadBudget ? { delegatedReadBudget: deps.delegatedReadBudget } : {}),
    ...(deps.collectPublicCourseContacts ? { collectPublicCourseContacts: true } : {}),
    ...(deps.allowCpsPhoneBookingContact ? { allowCpsPhoneBookingContact: true } : {}),
    ...(deps.allowTeeItUpContactChainRoot ? { allowTeeItUpContactChainRoot: true } : {}) });
  let capturedPage: OfficialIdentityPage | undefined;
  try {
    // loading covers every admitted resource, including ancillary reads. Wait
    // for this official document's rendered witness, then capture it afresh;
    // these diagnostic readiness facts never substitute for identity proof.
    const ready = (current: DiscoveryBrowserSnapshot) => current.officialSourceDiagnostic?.rawOfficialCaptured === true &&
      current.officialSourceDiagnostic.currentOfficialDocument === true && current.officialSourceDiagnostic.officialProvenance === true &&
      (deps.allowCpsPhoneBookingContact || deps.allowTeeItUpContactChainRoot ? current.officialSourceDiagnostic.renderedHeadingsPresent === true :
        current.officialSourceDiagnostic.renderedAddressesPresent === true) && current.officialSourceDiagnostic.renderedLinksPresent === true;
    const readable = (current: DiscoveryBrowserSnapshot) => {
      const lineage = current.nativeDocumentRedirects;
      const redirected = lineage && lineage.length > 0 && lineage.length <= 5 && lineage[0].fromUrl === pageUrl &&
        lineage.every((hop,index) => hop.completed === true && [301,302,303,307,308].includes(hop.status) &&
          isSafeRecipeUrl(hop.fromUrl) && isSafeRecipeUrl(hop.toUrl) && (index === 0 || lineage[index-1].toUrl === hop.fromUrl)) &&
        lineage.at(-1)?.toUrl === current.url;
      return (current.url === pageUrl || redirected) && current.navigationStatus === 200 &&
        current.browserTransport === "NATIVE_CHROME" && !current.accessRequirementObserved && !current.nativeFirstFatal;
    };
    let current = await session.execute({ id: 1, action: "open", url: pageUrl });
    let page: OfficialIdentityPage | undefined;
    for (let count = 0; count <= 4 && readable(current) && Date.now() < deadline.getTime(); count++) {
      if (ready(current)) {
        try { page = await session.readOfficialIdentityPage(); break; }
        catch (error) { if ((!deps.allowCpsPhoneBookingContact && !deps.allowTeeItUpContactChainRoot) || !(error instanceof Error) || error.message !== "OFFICIAL_POSTAL_SOURCE_UNVERIFIED") throw error; }
      }
      if (count < 4) current = await session.execute({ id: count + 2, action: "observe" });
    }
    if (!readable(current) || !ready(current) || !page) throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    if (page.url !== current.url || page.browserTransport !== "NATIVE_CHROME" || !page.visibleEvidence || Date.now() >= deadline.getTime())
      throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    capturedPage = registerFreshNativeOfficialIdentityPage(page, source.officialUrl, deadline, { requestedUrl: pageUrl, redirects: current.nativeDocumentRedirects ?? [] });
    return capturedPage;
  } finally {
    if (capturedPage) noteNativeOfficialIdentityPageCleanup(capturedPage, source.officialUrl, "BEFORE");
    let succeeded = false;
    try { await session.close(); succeeded = true; }
    finally { if (capturedPage) noteNativeOfficialIdentityPageCleanup(capturedPage, source.officialUrl, "AFTER", succeeded); }
  }
}

/** A delegated GET is a separately owned current source document. Its canonical
 * official root is preserved, and it never receives an official identity tag. */
export async function readNativeDelegatedDocument(source: OfficialIdentitySource, grant: DelegatedGetGrant, deps: Dependencies = {}) {
  const admitted = consumeDelegatedGet(grant);
  if (admitted.officialUrl !== source.officialUrl) throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
  const deadline = new Date(Math.min(admitted.deadlineAt.getTime(), Date.now() + 30_000));
  const factory = deps.createSession ?? createCourseDiscoveryBrowserSession;
  const session = await factory({ deadlineAt: deadline, initialUrls: [admitted.url], venueOfficialUrl: source.officialUrl,
    venueName: source.venueName, venueAddress: source.venueAddress, timeZone: source.timeZone },
  { requestLease: deps.requestLease, launchBrowser: deps.launchBrowser, browserTransport: "NATIVE_CHROME", captureDelegatedDocument: true,
    ...(deps.delegatedReadBudget ? { delegatedReadBudget: deps.delegatedReadBudget } : {}) });
  let failed = false;
  try {
    const current = await session.execute({ id: 1, action: "open", url: admitted.url });
    if (current.url !== admitted.url || current.navigationStatus !== 200 || current.browserTransport !== "NATIVE_CHROME" ||
        current.accessRequirementObserved || current.nativeFirstFatal) throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    if (!("readDelegatedSourceDocument" in session) || typeof session.readDelegatedSourceDocument !== "function") throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    let captured = await session.readDelegatedSourceDocument() as OfficialIdentityPage;
    const renderingEnd = Math.min(deadline.getTime(), Date.now() + 12000);
    const observedRequestedFrame = (page: OfficialIdentityPage) => {
      const frames=page.visibleEvidence?.delegatedFrameSources;
      if (!frames || frames.omitted || frames.rows.length !== 1) return false;
      const row=frames.rows[0];
      try { return row.visible && !row.srcdoc && !row.inForm && new URL(row.src,page.url).href === source.bookingUrl; } catch { return false; }
    };
    let observationId = 2;
    while (admitted.url !== source.bookingUrl && !captured.visibleEvidence?.linkUrls.includes(source.bookingUrl) && !observedRequestedFrame(captured) && Date.now() < renderingEnd) {
      await session.execute({ id: observationId++, action: "observe" });
      captured = await session.readDelegatedSourceDocument() as OfficialIdentityPage;
    }
    if (captured.url !== admitted.url || Date.now() >= deadline.getTime()) throw new Error("OFFICIAL_DELEGATED_SOURCE_UNVERIFIED");
    return registerFreshNativeDelegatedDocument(captured, admitted.officialUrl, deadline);
  } catch (error) { failed = true; throw error; }
  finally {
    try { await session.close(); } catch { if (!failed) throw new Error("OFFICIAL_DELEGATED_SOURCE_CLOSE_FAILED"); }
  }
}
