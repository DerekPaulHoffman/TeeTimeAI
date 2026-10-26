import { describe, expect, it } from "vitest";
import { requestFamilyForUrl } from "./request-family";
import { normalizeProviderFamilyKey } from "@/lib/automation/provider-capabilities";
import { createSimulatorBrowserRequestQueue } from "@/lib/automation/simulator-browser-request-queue";

describe("learned requests use the established provider mutex", () => {
  it("shares ForeUP's existing family lease across its public page and API", () => {
    expect(requestFamilyForUrl("https://foreupsoftware.com/index.php/booking/21017")).toBe("FOREUP");
    expect(requestFamilyForUrl("https://foreupsoftware.com/index.php/api/booking/times")).toBe("FOREUP");
  });

  it("keeps unknown hosts bounded by their actual hostname", () => {
    expect(requestFamilyForUrl("https://public.example.org/times")).toBe("public.example.org");
  });
  it("shares the exact Lightspeed public host across catalog and availability reads", () => {
    expect(requestFamilyForUrl("https://booking.lightspeed.app/example")).toBe("booking.lightspeed.app");
    expect(requestFamilyForUrl("https://booking.lightspeed.app/example/time?date=2026-10-23")).toBe("booking.lightspeed.app");
    expect(requestFamilyForUrl("https://booking.lightspeed.app.evil.example/example")).toBe("booking.lightspeed.app.evil.example");
  });
  it("shares USchedule browser, fixed adapter and legacy family without extending to other hosts", () => {
    const legacy = normalizeProviderFamilyKey("USCHEDULE");
    expect(requestFamilyForUrl("https://clients.uschedule.com/example/booking")).toBe(legacy);
    expect(requestFamilyForUrl("https://clients.uschedule.com/example/booking/changefield")).toBe(legacy);
    expect(requestFamilyForUrl("https://iframe.uschedule.com/example/booking")).toBe(legacy);
    expect(requestFamilyForUrl("https://iframe.uschedule.com/example/booking/changefield")).toBe(legacy);
    expect(requestFamilyForUrl("https://other.uschedule.com/example/booking")).toBe("other.uschedule.com");
    expect(requestFamilyForUrl("https://clients.uschedule.com.evil.example/booking")).toBe("clients.uschedule.com.evil.example");
    expect(requestFamilyForUrl("https://iframe.uschedule.com.evil.example/booking")).toBe("iframe.uschedule.com.evil.example");
  });
  it("serializes both exact USchedule public origins through one provider lane", async () => {
    const controller = new AbortController();let active = 0, maximum = 0, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered: string[] = [];
    const queue = createSimulatorBrowserRequestQueue(async (_family, work) => { active++;maximum = Math.max(maximum, active);try { return { acquired: true as const, value: await work() }; } finally { active--; } }, controller.signal);
    try { const first = queue.run(requestFamilyForUrl("https://clients.uschedule.com/example/booking"), async () => { entered.push("clients");await held; });
      const second = queue.run(requestFamilyForUrl("https://iframe.uschedule.com/example/booking"), async () => { entered.push("iframe"); });
      await Promise.resolve();expect(entered).toEqual(["clients"]);release();await Promise.all([first,second]);expect(entered).toEqual(["clients","iframe"]);expect(maximum).toBe(1);expect(active).toBe(0);
    } finally { release();controller.abort();queue.dispose(); }
  });
});
