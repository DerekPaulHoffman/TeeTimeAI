import type { OfficialIdentityPage, OfficialIdentitySource } from "./teeitup-official-identity";
import { createCourseDiscoveryBrowserSession, type DiscoveryBrowserSessionDependencies, type DiscoveryBrowserSnapshot } from "./browser-session";
import { isSafeRecipeUrl } from "./recipe";
import { registerFreshNativeOfficialIdentityPage } from "./native-official-page-attestation";

export type NativeOfficialPageReader = (source: OfficialIdentitySource, pageUrl: string, deadlineAt: Date) => Promise<OfficialIdentityPage>;
type Session = Pick<Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>>, "execute" | "readOfficialIdentityPage" | "close">;
type Dependencies = Pick<DiscoveryBrowserSessionDependencies, "requestLease" | "launchBrowser"> & {
  collectPublicCourseContacts?: true;
  createSession?: (input: Parameters<typeof createCourseDiscoveryBrowserSession>[0], deps: DiscoveryBrowserSessionDependencies) => Promise<Session>;
};

/** Controller-owned fresh isolated public reader. No model navigation or provider
 * API routes enter this one-page contract; the shared native proxy guards all
 * network traffic and the browser session owns status/challenge/visibility. */
export async function readNativeOfficialIdentityPage(source: OfficialIdentitySource, pageUrl: string, deadlineAt: Date,
  deps: Dependencies = {}): Promise<OfficialIdentityPage> {
  if (!source.officialUrl || !isSafeRecipeUrl(pageUrl) || !isSafeRecipeUrl(source.officialUrl) ||
      new URL(pageUrl).origin !== new URL(source.officialUrl).origin) throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
  const deadline = new Date(Math.min(deadlineAt.getTime(), Date.now() + 30_000));
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) throw new Error("DEADLINE_EXCEEDED");
  const createSession = deps.createSession ?? createCourseDiscoveryBrowserSession;
  const session = await createSession({ deadlineAt: deadline, initialUrls: [pageUrl], venueName: source.venueName,
    venueAddress: source.venueAddress, venueOfficialUrl: source.officialUrl, timeZone: source.timeZone },
  { requestLease: deps.requestLease, launchBrowser: deps.launchBrowser, browserTransport: "NATIVE_CHROME",
    ...(deps.collectPublicCourseContacts ? { collectPublicCourseContacts: true } : {}) });
  try {
    // loading covers every admitted resource, including ancillary reads. Wait
    // for this official document's rendered witness, then capture it afresh;
    // these diagnostic readiness facts never substitute for identity proof.
    const ready = (current: DiscoveryBrowserSnapshot) => current.officialSourceDiagnostic?.rawOfficialCaptured === true &&
      current.officialSourceDiagnostic.currentOfficialDocument === true && current.officialSourceDiagnostic.officialProvenance === true &&
      current.officialSourceDiagnostic.renderedAddressesPresent === true && current.officialSourceDiagnostic.renderedLinksPresent === true;
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
    for (let count = 0; readable(current) && !ready(current) && count < 4 && Date.now() < deadline.getTime(); count++) current = await session.execute({ id: count + 2, action: "observe" });
    if (!readable(current) || !ready(current))
      throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    const page = await session.readOfficialIdentityPage();
    if (page.url !== current.url || page.browserTransport !== "NATIVE_CHROME" || !page.visibleEvidence || Date.now() >= deadline.getTime())
      throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    return registerFreshNativeOfficialIdentityPage(page, source.officialUrl, deadline);
  } finally { await session.close(); }
}
