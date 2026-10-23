import type { OfficialIdentityPage, OfficialIdentitySource } from "./teeitup-official-identity";
import { createCourseDiscoveryBrowserSession, type DiscoveryBrowserSessionDependencies } from "./browser-session";
import { isSafeRecipeUrl } from "./recipe";

export type NativeOfficialPageReader = (source: OfficialIdentitySource, pageUrl: string, deadlineAt: Date) => Promise<OfficialIdentityPage>;
type Session = Pick<Awaited<ReturnType<typeof createCourseDiscoveryBrowserSession>>, "execute" | "readOfficialIdentityPage" | "close">;
type Dependencies = Pick<DiscoveryBrowserSessionDependencies, "requestLease" | "launchBrowser"> & {
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
  { requestLease: deps.requestLease, launchBrowser: deps.launchBrowser, browserTransport: "NATIVE_CHROME" });
  try {
    let current = await session.execute({ id: 1, action: "open", url: pageUrl });
    for (let count = 0; current.loading && count < 4 && Date.now() < deadline.getTime(); count++) current = await session.execute({ id: count + 2, action: "observe" });
    if (current.url !== pageUrl || current.navigationStatus !== 200 || current.loading || current.accessRequirementObserved || current.nativeFirstFatal)
      throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    const page = await session.readOfficialIdentityPage();
    if (page.url !== pageUrl || page.browserTransport !== "NATIVE_CHROME" || !page.visibleEvidence || Date.now() >= deadline.getTime())
      throw new Error("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    return page;
  } finally { await session.close(); }
}
