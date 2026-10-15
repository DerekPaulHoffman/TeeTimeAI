// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectInteractiveSimulatorResearch, interactiveControlKind, isAnonymousBrowserReadPost } from "./simulator-interactive-browser";

describe("interactive public research boundaries", () => {
  it("offers navigation and calendar filters, never slots, checkout or contact controls", () => {
    const button = (name: string) => ({ tag: "button", role: "", name, label: "" });
    expect(interactiveControlKind(button("Next month"))).toBe("calendar");
    expect(interactiveControlKind({ tag: "select", role: "", name: "", label: "Duration" })).toBe("filter");
    expect(interactiveControlKind(button("1:30 PM"))).toBeNull();
    expect(interactiveControlKind(button("Confirm reservation"))).toBeNull();
    expect(interactiveControlKind(button("Send email"))).toBeNull();
    expect(interactiveControlKind({ tag: "input", role: "", name: "", label: "Search courses", inputType: "search" })).toBe("field");
    expect(interactiveControlKind({ tag: "input", role: "", name: "", label: "Email", inputType: "email" })).toBeNull();
    expect(interactiveControlKind({ ...button("Search"), sensitiveForm: true })).toBeNull();
    expect(interactiveControlKind({ tag: "a", role: "", name: "Reservations", label: "", href: "https://public.example.test/calendar" })).toBe("link");
    expect(interactiveControlKind({ tag: "a", role: "", name: "Login", label: "", href: "https://public.example.test/login" })).toBeNull();
  });

  it("admits bounded anonymous queries and rejects mutations, credentials and unknown POSTs", () => {
    const url = new URL("https://public.example.test/graphql");
    const headers = new Headers({ "content-type": "application/json" });
    const check = (value: unknown) => isAnonymousBrowserReadPost(url, headers, JSON.stringify(value));
    expect(check({ query: "query Calendar { slots { time } }", variables: { date: "2026-10-15" } })).toBe(true);
    expect(check({ action: "getAvailableSlots", date: "2026-10-15" })).toBe(true);
    expect(check({ query: "mutation Reserve { reserve { id } }" })).toBe(false);
    expect(check({ query: "{ slots { time } }", token: "private" })).toBe(false);
    expect(check({ action: "unknown", date: "2026-10-15" })).toBe(false);
    expect(check({ action: "getSlots", email: "private@example.test" })).toBe(false);
  });

  it("runs an isolated real browser with visual feedback and interactive duration selection", async () => {
    const channel = resolve(".codex-artifacts/browser", `fixture-${randomUUID()}`);
    await mkdir(channel, { recursive: true });
    const visited: string[] = [];
    const assertOwned = vi.fn(async () => {});
    const html = `<html><body><h1>Public simulator fixture</h1>
      <label for="duration">Duration</label><select id="duration"><option>30 minutes</option><option>60 minutes</option></select>
      <button id="next">Next month</button><div id="state">October</div><button>1:00 PM</button>
      <label for="find">Search courses</label><input id="find" type="search"><div id="found"></div>
      <button>Confirm reservation</button><a href="/login">Login</a>
      <script>document.querySelector('#duration').onchange=e=>document.querySelector('#state').textContent=e.target.value;
      document.querySelector('#next').onclick=()=>document.querySelector('#state').textContent='November';
      document.querySelector('#find').oninput=e=>document.querySelector('#found').textContent=e.target.value;
      fetch('/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'query Calendar { slots { time } }'})});</script>
      </body></html>`;
    const fetch = vi.fn(async (url: Parameters<typeof global.fetch>[0]) => {
      visited.push(String(url));
      return new Response(String(url).endsWith("/graphql") ? '{"slots":[{"time":"13:00"}]}' : html,
        { headers: { "content-type": String(url).endsWith("/graphql") ? "application/json" : "text/html" } });
    }) as typeof global.fetch;
    const lease = (async (_family: string, work: () => Promise<unknown>) => ({ acquired: true, value: await work() })) as never;
    const wait = async (number: number) => {
      for (let i = 0; i < 200; i++) {
        try { return JSON.parse(await readFile(join(channel, `response-${number}.json`), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await new Promise(r => setTimeout(r, 50)); }
      }
      throw new Error("Fixture response timeout");
    };
    const task = collectInteractiveSimulatorResearch({ url: "https://public.example.test/calendar", channel, assertOwned }, { fetch, lease });
    try {
      const first = await wait(0);
      expect(first.screenshot.length).toBeGreaterThan(1000);
      expect(first.controls.some((control: { name: string }) => control.name === "Confirm reservation" || control.name === "1:00 PM" || control.name === "Login")).toBe(false);
      const duration = first.controls.find((control: { label: string }) => control.label.includes("Duration"));
      await writeFile(join(channel, "request-1.json"), JSON.stringify({ action: "select", target: duration.target, option: "60 minutes" }));
      const second = await wait(1);
      expect(second.text).toContain("60 minutes");
      const search = second.controls.find((control: { kind: string }) => control.kind === "field");
      await writeFile(join(channel, "request-2.json"), JSON.stringify({ action: "fill", target: search.target, text: "Public course" }));
      const third = await wait(2);
      expect(third.text).toContain("Public course");
      const next = third.controls.find((control: { name: string }) => control.name === "Next month");
      await writeFile(join(channel, "request-3.json"), JSON.stringify({ action: "click", target: next.target }));
      expect((await wait(3)).text).toContain("November");
      await writeFile(join(channel, "request-4.json"), JSON.stringify({ action: "finish" }));
      const result = await task;
      expect(result.text).toContain("November");
      expect(result.method).toBe("BROWSER");
      expect(result.responseContracts).toHaveLength(1);
      expect(visited).toEqual(["https://public.example.test/calendar", "https://public.example.test/graphql"]);
      expect(assertOwned.mock.calls.length).toBeGreaterThanOrEqual(5);
    } finally {
      // The known fixture directory is always beneath the private browser root.
      if (!channel.startsWith(resolve(".codex-artifacts/browser") + "/") && !channel.startsWith(resolve(".codex-artifacts/browser") + "\\")) throw new Error("Bad fixture path");
      await rm(channel, { recursive: true, force: true });
    }
  }, 25_000);
});
