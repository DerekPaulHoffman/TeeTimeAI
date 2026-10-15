// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectInteractiveSimulatorResearch, interactiveControlKind, isAnonymousBrowserReadPost } from "./simulator-interactive-browser";
import { classifySimulatorSupportFailure } from "./simulator-support-failure";

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
    expect(check({ action: "getAvailableSlots", date: "2026-10-15" })).toBe(false);
    expect(check({ query: "mutation Reserve { reserve { id } }" })).toBe(false);
    expect(check({ query: "{ slots { time } }", token: "private" })).toBe(false);
    expect(check({ action: "unknown", date: "2026-10-15" })).toBe(false);
    expect(check({ action: "getSlots", email: "private@example.test" })).toBe(false);
    expect(isAnonymousBrowserReadPost(new URL("https://api.passfactory.io/api/v1/booking/create"), headers,
      JSON.stringify({ query: "{ slots { time } }" }))).toBe(false);
  });

  it("follows an observed new-tab booking link and waits for slow calendar resources", async () => {
    const channel = resolve(".codex-artifacts/browser", `fixture-${randomUUID()}`);
    await mkdir(channel, { recursive: true });
    let stopped = false;
    let nextRequest = 1;
    const visited: string[] = [];
    const fetch = vi.fn(async (url: Parameters<typeof global.fetch>[0]) => {
      const path = String(url);
      visited.push(path);
      if (path.endsWith("/calendar.js")) {
        await new Promise(r => setTimeout(r, 6_000));
        return new Response(`document.querySelector('#calendar').textContent='Available calendar';
          fetch('/calendar/private-venue-id?private=query', {method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({action:'getAvailableSlots',date:'2026-10-15'})}).catch(()=>{});
          fetch('/api/calendar-data', {headers:{Authorization:'Bearer private-token'}}).catch(()=>{});
          fetch('https://external.example.test/api/private-operation', {method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({action:'getAvailableSlots',date:'2026-10-15'})}).catch(()=>{});
          fetch('https://external.example.test/api/private-contact', {method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({action:'sendContact',email:'private@example.test'})}).catch(()=>{});`, { headers: { "content-type": "text/javascript" } });
      }
      if (path.endsWith("/calendar.woff2")) {
        await new Promise(r => setTimeout(r, 12_000));
        return new Response(new Uint8Array([0]), { headers: { "content-type": "font/woff2" } });
      }
      return new Response(path.includes("booking.example.test")
        ? '<html><style>@font-face{font-family:Calendar;src:url(/calendar.woff2)}body{font-family:Calendar}</style><body><div id="calendar">Loading calendar</div><script defer src="/calendar.js"></script><label>Duration<select><option>60 minutes</option></select></label></body></html>'
        : '<html><body><a target="_blank" href="https://booking.example.test/calendar">Reservations</a></body></html>',
      { headers: { "content-type": "text/html" } });
    }) as typeof global.fetch;
    const leasedHosts = new Set<string>();
    let busyDenials = 0;
    const lease = (async (family: string, work: () => Promise<unknown>) => {
      if (leasedHosts.has(family)) { busyDenials++; return { acquired: false }; }
      leasedHosts.add(family);
      try { return { acquired: true, value: await work() }; }
      finally { leasedHosts.delete(family); }
    }) as never;
    const task = collectInteractiveSimulatorResearch({ url: "https://public.example.test", channel,
      assertOwned: async () => { if (stopped) throw new Error("Fixture stopped"); } }, { fetch, lease });
    // Keep failures observable even when the collector exits before a response.
    const settled = task.then(value => ({ value }), error => ({ error }));
    const wait = async (number: number) => {
      for (let i = 0; i < 500; i++) {
        try { return JSON.parse(await readFile(join(channel, `response-${number}.json`), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await new Promise(r => setTimeout(r, 50)); }
      }
      throw new Error("Fixture response timeout");
    };
    try {
      const first = await wait(0);
      const reservations = first.controls.find((control: { name: string }) => control.name === "Reservations");
      await writeFile(join(channel, "request-1.json"), JSON.stringify({ action: "click", target: reservations.target }));
      nextRequest = 2;
      const second = await wait(1);
      expect(second.url).toBe("https://booking.example.test/calendar");
      expect(second.text).toContain("Available calendar");
      expect(second.loading).toBe(false);
      expect(second.screenshot.length).toBeGreaterThan(1000);
      expect(visited).toContain("https://booking.example.test/calendar.js");
      expect(visited).toContain("https://booking.example.test/calendar.woff2");
      await writeFile(join(channel, "request-2.json"), JSON.stringify({ action: "finish" }));
      const result = await task;
      expect(result.text).toContain("Available calendar");
      expect(result.renderComplete).toBe(false);
      expect(result.renderWarning).toBe("SECONDARY_REQUESTS_BLOCKED");
      expect(result.blockedResourceDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
        state: "NOT_EXECUTED", resourceKind: "FETCH", method: "POST", reason: "METHOD_NOT_ALLOWED",
        originRelation: "SAME_SITE", pathShape: "/calendar/:value",
        bodyShape: { format: "JSON", fieldKinds: ["ACTION", "DATE"], operationHints: ["AVAILABILITY", "READ"] },
      }), expect.objectContaining({ reason: "SENSITIVE_HEADERS", headerKinds: ["AUTHORIZATION"] }),
      expect.objectContaining({ originRelation: "OTHER_ORIGIN", declaredOrigin: "https://external.example.test" })]));
      const contact = result.blockedResourceDiagnostics?.find(row => row.bodyShape?.fieldKinds.includes("CONTACT"));
      expect(contact).toBeDefined();
      expect(contact?.declaredOrigin).toBeUndefined();
      expect(JSON.stringify(result.blockedResourceDiagnostics)).not.toMatch(/private-|private=query|2026-10-15|getAvailableSlots|sendContact|private@example/u);
      expect(visited.some(url => /private-|calendar-data|external\.example/u.test(url))).toBe(false);
      expect(busyDenials).toBe(0);
    } finally {
      stopped = true;
      await writeFile(join(channel, `request-${nextRequest}.json`), JSON.stringify({ action: "finish" })).catch(() => {});
      await settled;
      if (!channel.startsWith(resolve(".codex-artifacts/browser") + "/") && !channel.startsWith(resolve(".codex-artifacts/browser") + "\\")) throw new Error("Bad fixture path");
      await rm(channel, { recursive: true, force: true });
    }
  }, 35_000);

  it("retains the trusted request phase when navigation fails after a resource timeout", async () => {
    const channel = resolve(".codex-artifacts/browser", `fixture-${randomUUID()}`);
    await mkdir(channel, { recursive: true });
    const error = new Error("Private network details must not escape");
    error.name = "TimeoutError";
    const lease = (async (_family: string, work: () => Promise<unknown>) => ({ acquired: true, value: await work() })) as never;
    try {
      await expect(collectInteractiveSimulatorResearch({ url: "https://public.example.test", channel, assertOwned: async () => {} },
        { fetch: async () => { throw error; }, lease })).rejects.toBe(error);
      expect(classifySimulatorSupportFailure(error, "PUBLIC_READ")).toMatchObject({
        code: "PUBLIC_READ_TIMEOUT", category: "NETWORK", researchPhase: "BROWSER_REQUEST",
      });
    } finally {
      if (!channel.startsWith(resolve(".codex-artifacts/browser") + "/") && !channel.startsWith(resolve(".codex-artifacts/browser") + "\\")) throw new Error("Bad fixture path");
      await rm(channel, { recursive: true, force: true });
    }
  });

  it("loads scoped public widget data while keeping telemetry blocked", async () => {
    const channel = resolve(".codex-artifacts/browser", `fixture-${randomUUID()}`);
    await mkdir(channel, { recursive: true });
    let stopped = false, sequence = 1;
    const visited: string[] = [];
    const html = `<html><body><div id="calendar">Loading</div><script type="module">
      const body={facility_code:'Public123',start_date:'2026-10-01',end_date:'2026-10-31',type:2};
      await fetch('https://api.passfactory.io/api/v1/availability-widget/get-business-info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({facility_code:'Public123'})});
      await fetch('https://api.passfactory.io/api/v1/availability-widget/facility-widget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      fetch('https://analytics.google.com/g/collect',{method:'POST',body:'tracking'}).catch(()=>{});
      document.querySelector('#calendar').textContent='Available public calendar';
      </script></body></html>`;
    const fetch = vi.fn(async (input: Parameters<typeof global.fetch>[0], init?: RequestInit) => {
      const url = String(input); visited.push(url);
      if (url.startsWith("https://api.passfactory.io/")) {
        expect(init?.method).toBe("POST"); expect(init?.credentials).toBe("omit");
        return new Response('{"data":{"available":true}}', { headers: { "content-type": "application/json", "access-control-allow-origin": "https://passfactory.com" } });
      }
      return new Response(url.startsWith("https://official.example.test/")
        ? `<html><body><a href="https://passfactory.com/ftbb/Public123/">Reservations</a><script>fetch('/marketing-ping',{method:'POST',body:'ignored'}).catch(()=>{});</script></body></html>`
        : html, { headers: { "content-type": "text/html" } });
    }) as typeof global.fetch;
    const lease = (async (_host: string, work: () => Promise<unknown>) => ({ acquired: true, value: await work() })) as never;
    let failure: unknown;
    const task = collectInteractiveSimulatorResearch({ url: "https://official.example.test/", channel,
      assertOwned: async () => { if (stopped) throw new Error("Fixture stopped"); } }, { fetch, lease });
    const settled = task.catch(error => { failure = error; });
    const wait = async (number: number) => {
      for (let i = 0; i < 200; i++) {
        if (failure) throw failure;
        try { return JSON.parse(await readFile(join(channel, `response-${number}.json`), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await new Promise(r => setTimeout(r, 50)); }
      }
      throw new Error("Fixture response timeout");
    };
    try {
      let view = await wait(0);
      const reservations = view.controls.find((control: { name: string }) => control.name === "Reservations");
      await writeFile(join(channel, `request-${sequence}.json`), JSON.stringify({ action: "click", target: reservations.target }));
      view = await wait(sequence++);
      while ((view.loading || !view.text.includes("Available public calendar")) && sequence < 4) {
        await writeFile(join(channel, `request-${sequence}.json`), JSON.stringify({ action: "observe" }));
        view = await wait(sequence++);
      }
      expect(view.text).toContain("Available public calendar");
      await writeFile(join(channel, `request-${sequence}.json`), JSON.stringify({ action: "finish" }));
      const result = await task;
      expect(result.renderComplete).toBe(true);
      expect(result.blockedRequests).toBeGreaterThan(0);
      expect(result.renderWarning).toBeUndefined();
      expect(visited.filter(url => url.startsWith("https://api.passfactory.io/"))).toHaveLength(2);
      expect(visited.some(url => url.includes("analytics.google.com"))).toBe(false);
    } finally {
      stopped = true;
      await writeFile(join(channel, `request-${sequence}.json`), JSON.stringify({ action: "finish" })).catch(() => {});
      await settled;
      if (!channel.startsWith(resolve(".codex-artifacts/browser") + "/") && !channel.startsWith(resolve(".codex-artifacts/browser") + "\\")) throw new Error("Bad fixture path");
      await rm(channel, { recursive: true, force: true });
    }
  }, 25_000);

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
