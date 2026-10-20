import { describe, expect, it, vi } from "vitest";
import { createUSchedulePublicSession } from "./uschedule-public-session";
const source = "https://clients.uschedule.com/example-golf/booking";
const cookie = "ASP.NET_SessionId=AnonymousTest123";
const html = `<select id="select_service"><option value="72">Simulator Rental</option></select>
<select id="select_length"><option value="60">1 hour</option></select>
<script>\nvar lastAvailTime = '102320261230';\n</script>`;
const lease = async <T>(_family: string, work: () => Promise<T>) => ({ acquired: true as const, value: await work() });
const bootstrap = (sessionCookie = cookie) => new Response(html, { headers: { "content-type": "text/html", "set-cookie": `${sessionCookie}; HttpOnly; Secure` } });
const post = (value: string) => ({ method: "POST", headers: { "content-type": "application/json", origin: "https://clients.uschedule.com", referer: source, Cookie: cookie }, body: value });
describe("USchedule execution-only anonymous session", () => {
  it("only accepts the exact session returned by its own fresh public GET", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(bootstrap()).mockResolvedValueOnce(Response.json({ code: "refresh" }));
    const session = createUSchedulePublicSession(source, { fetch, requestLease: lease });
    try {
      await expect(session.read(source, { headers: { cookie } })).rejects.toThrow("UNSAFE_ADAPTER_REQUEST");
      await session.read(source);
      await session.read(`${source}/changefield`, post('[{"Name":"length","Value":"60"}]'));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(new Headers(fetch.mock.calls[1][1]?.headers).has("cookie")).toBe(false);
      await expect(session.read(source, { headers: { cookie: "ASP.NET_SessionId=OtherSession123" } })).rejects.toThrow("UNSAFE_ADAPTER_REQUEST");
      await expect(session.read(source.replace("example-golf", "another-golf"))).rejects.toThrow("UNSCOPED_ADAPTER_REQUEST");
    } finally { session.dispose(); }
    await expect(session.read(source)).rejects.toThrow("ADAPTER_REQUEST_LIMIT");
  });
  it("refuses replacement/authentication cookies and does not share sessions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(bootstrap()).mockResolvedValueOnce(bootstrap("AUTH=private"));
    const one = createUSchedulePublicSession(source, { fetch, requestLease: lease });
    const two = createUSchedulePublicSession(source, { fetch, requestLease: lease });
    try {
      await one.read(source);
      await expect(two.read(source, { headers: { cookie } })).rejects.toThrow("UNSAFE_ADAPTER_REQUEST");
      await expect(one.read(source)).rejects.toThrow("ANONYMOUS_SESSION_CHANGED");
    } finally { one.dispose(); two.dispose(); }
  });
  it("only permits the exact observed read cursor and never a time/payment value", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(bootstrap()).mockResolvedValueOnce(Response.json({ code: "refresh" }));
    const session = createUSchedulePublicSession(source, { fetch, requestLease: lease });
    try {
      await session.read(source);
      await expect(session.read(`${source}/changefield`, post('[{"Name":"more_next_avail","Value":"102320261245"}]'))).rejects.toThrow("UNSAFE_ADAPTER_REQUEST");
      await expect(session.read(`${source}/changefield`, post('[{"Name":"time","Value":"102320261230"}]'))).rejects.toThrow("UNSAFE_ADAPTER_REQUEST");
      await session.read(`${source}/changefield`, post('[{"Name":"more_next_avail","Value":"102320261230"}]'));
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { session.dispose(); }
  });
  it("preserves throttling as a transient read failure", async () => {
    const session = createUSchedulePublicSession(source, { fetch: vi.fn().mockResolvedValue(new Response(null, { status: 429 })), requestLease: lease });
    try { await expect(session.read(source)).rejects.toThrow("PROVIDER_THROTTLED"); expect(session.failureReason()).toBe("PROVIDER_THROTTLED"); }
    finally { session.dispose(); }
  });
});
