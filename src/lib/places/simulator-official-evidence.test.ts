import { describe, expect, it, vi } from "vitest";
import { readOfficialSimulatorEvidence } from "./simulator-official-evidence";

const lease = async <T,>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() });
describe("official simulator intake corroboration", () => {
  it("reads only the official HTML anonymously and establishes likely identity, not inventory", async () => {
    const fetch = vi.fn(async () => new Response("<h1>The Clubhouse</h1><p>Book our golf &amp; sports simulators by the hour.</p>", { headers: { "content-type": "text/html" } }));
    expect(await readOfficialSimulatorEvidence("https://clubhouse.example/", undefined, { fetch, lease })).toBe("LIKELY");
    expect(fetch).toHaveBeenCalledWith("https://clubhouse.example/", expect.objectContaining({ method: "GET", credentials: "omit" }));
  });
  it("uses one official About page when the multi-sport homepage does not describe its simulators", async () => {
    const fetch = vi.fn(async (url: string) => new Response(url.endsWith("/about")
      ? '<h1>About the sports club</h1><p>Two Trackman golf simulators.</p><a href="/play">Book now</a>'
      : '<nav><a href="/about">About</a></nav><h1>Padel, pickleball and golf</h1><footer><a href="/about">About us</a></footer>',
    { headers: { "content-type": "text/html" } }));
    await expect(readOfficialSimulatorEvidence("https://clubhouse.example/", undefined, { fetch, lease })).resolves.toBe("LIKELY");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://clubhouse.example/", "https://clubhouse.example/about"]);
  });
  it.each([
    '<nav><a href="https://other.example/about">About</a></nav>',
    '<nav><a href="/about?token=1">About</a></nav>',
    '<nav hidden><a href="/about">About</a></nav>',
    '<a href="/about">About</a><a href="/about-us">About us</a>',
  ])("does not follow an untrusted or ambiguous About link", async html => {
    const fetch = vi.fn(async () => new Response(html, { headers: { "content-type": "text/html" } }));
    await expect(readOfficialSimulatorEvidence("https://clubhouse.example/", undefined, { fetch, lease })).resolves.toBe("ABSENT");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "<script>Book golf simulators</script><p>Restaurant</p>",
    "<div hidden>Book golf simulators</div><p>Restaurant</p>",
    "<div aria-hidden='true'>Book golf simulators</div>",
    "<p>Book our restaurant table</p>",
    "<p>We install golf simulators.</p>",
  ])("does not invent simulator evidence from unrelated or nonvisible content", async html => {
    expect(await readOfficialSimulatorEvidence("https://clubhouse.example/", undefined, {
      fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }), lease })).toBe("ABSENT");
  });
  it.each(["http://127.0.0.1/", "https://user:secret@clubhouse.example/", "https://clubhouse.example/?token=secret"])("never requests unsafe or parameterized official source %s", async website => {
    const fetch = vi.fn();
    expect(await readOfficialSimulatorEvidence(website, undefined, { fetch, lease })).toBe("ABSENT");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps access failure, contention, non-HTML and oversized responses unavailable", async () => {
    for (const response of [new Response("Denied", { status: 403 }), Response.json({ text: "Book golf simulators" }),
      new Response("x".repeat(2_000_001), { headers: { "content-type": "text/html" } })]) {
      expect(await readOfficialSimulatorEvidence("https://clubhouse.example/", undefined, { fetch: async () => response, lease })).toBe("UNAVAILABLE");
    }
    expect(await readOfficialSimulatorEvidence("https://clubhouse.example/", undefined, { lease: async () => ({ acquired: false }) })).toBe("UNAVAILABLE");
  });
});
