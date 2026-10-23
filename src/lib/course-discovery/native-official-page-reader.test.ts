import { describe, expect, it, vi } from "vitest";
import { readNativeOfficialIdentityPage } from "./native-official-page-reader";
import type { DiscoveryBrowserSnapshot } from "./browser-session";

const source = { officialUrl: "https://example.org/", bookingUrl: "https://harbor.book.teeitup.com/", venueName: "Harbor Golf Course",
  venueAddress: "10 Harbor Drive, Example, NY 12345, USA", timeZone: "America/New_York" };
function fixture(change: Partial<DiscoveryBrowserSnapshot> = {}) {
  const execute = vi.fn(async () => ({ url: source.officialUrl, navigationStatus: 200, loading: false, ...change } as DiscoveryBrowserSnapshot));
  const readOfficialIdentityPage = vi.fn(async () => ({ url: source.officialUrl, html: "<html></html>", browserTransport: "NATIVE_CHROME" as const,
    visibleEvidence: { title: source.venueName, headings: [], addressTexts: [], linkUrls: [] } }));
  const close = vi.fn(async () => {}), createSession = vi.fn(async () => ({ execute, readOfficialIdentityPage, close }));
  return { execute, readOfficialIdentityPage, close, createSession };
}
describe("fixed native official source reader", () => {
  it("admits only the official origin, owns a fresh native session and always closes it", async () => {
    const session = fixture();
    await readNativeOfficialIdentityPage(source, source.officialUrl, new Date(Date.now() + 120_000), session);
    const [input, options] = session.createSession.mock.calls[0] as unknown as [{ deadlineAt: Date; initialUrls: string[] }, { browserTransport: string }];
    expect(input.initialUrls).toEqual([source.officialUrl]);
    expect(input.deadlineAt.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(options.browserTransport).toBe("NATIVE_CHROME");
    expect(session.execute).toHaveBeenCalledWith({ id: 1, action: "open", url: source.officialUrl });
    expect(session.close).toHaveBeenCalledOnce();
  });
  it.each([{ navigationStatus: 401 }, { navigationStatus: 403 }, { accessRequirementObserved: true }, { loading: true },
    { url: "https://unrelated.example/" }])("rejects incomplete, challenged or changed documents and closes (%j)", async change => {
    const session = fixture(change);
    await expect(readNativeOfficialIdentityPage(source, source.officialUrl, new Date(Date.now() + 30_000), session)).rejects.toThrow("OFFICIAL_POSTAL_SOURCE_UNVERIFIED");
    expect(session.readOfficialIdentityPage).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledOnce();
  });
  it("closes the browser when trusted visibility capture fails", async () => {
    const session = fixture(); session.readOfficialIdentityPage.mockRejectedValueOnce(new Error("DOCUMENT_CHANGED"));
    await expect(readNativeOfficialIdentityPage(source, source.officialUrl, new Date(Date.now() + 30_000), session)).rejects.toThrow("DOCUMENT_CHANGED");
    expect(session.close).toHaveBeenCalledOnce();
  });
  it("rejects unrelated origins before browser creation", async () => {
    const session = fixture();
    await expect(readNativeOfficialIdentityPage(source, "https://unrelated.example/", new Date(Date.now() + 30_000), session)).rejects.toThrow();
    expect(session.createSession).not.toHaveBeenCalled();
  });
});
