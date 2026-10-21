// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { chromium } from "@playwright/test";
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

  it.each(["public-course.ezlinksgolf.com", "api.ezlinksgolf.com", "ezlinksgolf.com"])("does not let GraphQL-shaped fields bypass the exact EZLinks read contract on %s", hostname => {
    const headers = new Headers({ "content-type": "application/json" });
    for (const path of ["/api/search/search", "/api/search/gsahs", "/api/reservation/create"]) {
      const url = new URL(`https://${hostname}${path}`);
      for (const p07 of [false, true]) expect(isAnonymousBrowserReadPost(url, headers, JSON.stringify({
        query: "{ slots { time } }", p01: [17], p02: "10/23/2026", p03: "08:00", p04: "18:00", p05: 0, p06: 2, p07,
      }))).toBe(false);
    }
    expect(isAnonymousBrowserReadPost(new URL("https://calendar.example.org/graphql"), headers,
      JSON.stringify({ query: "{ slots { time } }" }))).toBe(true);
  });

  it("recognizes named listbox popup filters without admitting other popup actions", () => {
    const popup = { tag: "div", role: "button", name: "", label: "Duration", hasPopup: "listbox" };
    expect(interactiveControlKind(popup)).toBe("filter");
    expect(interactiveControlKind({ ...popup, label: "Party size" })).toBe("filter");
    expect(interactiveControlKind({ ...popup, label: "" })).toBeNull();
    expect(interactiveControlKind({ ...popup, label: "Duration", hasPopup: "dialog" })).toBeNull();
    expect(interactiveControlKind({ ...popup, label: "Reserve duration" })).toBeNull();
    expect(interactiveControlKind({ ...popup, sensitiveForm: true })).toBeNull();
    expect(interactiveControlKind({ ...popup, name: "1:00 PM" })).toBeNull();
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

  it("loads a hall published through the widget URL while keeping other halls and telemetry blocked", async () => {
    const channel = resolve(".codex-artifacts/browser", `fixture-${randomUUID()}`);
    await mkdir(channel, { recursive: true });
    let stopped = false, sequence = 1;
    const visited: string[] = [];
    const html = `<html><body><div id="calendar">Loading</div><script type="module">
      const body={facility_code:'Public123',start_date:'2026-10-01',end_date:'2026-10-31',type:2};
      await fetch('https://api.passfactory.io/api/v1/availability-widget/get-business-info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({facility_code:'Public123'})});
      await fetch('https://api.passfactory.io/api/v1/availability-widget/facility-widget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      history.replaceState(null,'','?sc=Hall456');
      const hallBody={hall_code:'Hall456',start_date:body.start_date,end_date:body.end_date,type:2};
      await fetch('https://api.passfactory.io/api/v1/availability-widget/hall-widget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(hallBody)});
      await fetch('https://api.passfactory.io/api/v1/availability-widget/hall-widget',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...hallBody,hall_code:'Unobserved'})}).catch(()=>{});
      fetch('https://analytics.google.com/g/collect',{method:'POST',body:'tracking'}).catch(()=>{});
      document.querySelector('#calendar').textContent='Available public calendar';
      </script></body></html>`;
    const fetch = vi.fn(async (input: Parameters<typeof global.fetch>[0], init?: RequestInit) => {
      const url = String(input); visited.push(url);
      if (url.startsWith("https://api.passfactory.io/")) {
        expect(init?.method).toBe("POST"); expect(init?.credentials).toBe("omit");
        expect(JSON.parse(String(init?.body)).hall_code).not.toBe("Unobserved");
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
      expect(result.renderComplete).toBe(false);
      expect(result.blockedRequests).toBeGreaterThan(0);
      expect(result.renderWarning).toBe("SECONDARY_REQUESTS_BLOCKED");
      expect(visited.filter(url => url.startsWith("https://api.passfactory.io/"))).toHaveLength(3);
      expect(visited.some(url => url.includes("analytics.google.com"))).toBe(false);
    } finally {
      stopped = true;
      await writeFile(join(channel, `request-${sequence}.json`), JSON.stringify({ action: "finish" })).catch(() => {});
      await settled;
      if (!channel.startsWith(resolve(".codex-artifacts/browser") + "/") && !channel.startsWith(resolve(".codex-artifacts/browser") + "\\")) throw new Error("Bad fixture path");
      await rm(channel, { recursive: true, force: true });
    }
  }, 25_000);

  it.each(["unchanged", "history", "navigation", "reload"])("retains only the current document's display facts (%s)", async (change) => {
    const channel = resolve(".codex-artifacts/browser", `fixture-${randomUUID()}`);
    await mkdir(channel, { recursive: true });
    const api = "https://api.passfactory.io/api/v1/availability-widget/";
    const fixture = { code: 200, payload: { code: "publicHall", name: "Public hall", rule_times: [{
      code: "publicRule", name: "Public hours", settings_for: "public", availability_ticket_type: "GENERAL_TABLE",
      multi_booking_enabled: false, minutes_per_booking: null, availabilities: [{ table_id: "publicTable", table_title: "Golf simulator",
        start_date: "2026-10-16", end_date: "2026-10-16", start_time: "13:00:00", end_time: "17:00:00", slot_duration: 60, availability_type: 2 }],
    }] } };
    const visited: string[] = [];
    let documents = 0;
    const fetch = vi.fn(async (url: Parameters<typeof global.fetch>[0]) => {
      const value = String(url); visited.push(value);
      if (value.endsWith("/calendar.js")) return new Response("async function loadAvailability(){return fetch('/api/availability')}",
        { headers: { "content-type": "application/javascript" } });
      if (value.startsWith(api)) return new Response(JSON.stringify(value.endsWith("hall-widget") ? fixture : { code: 200, payload: {} }),
        { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
      if (++documents > 1) return new Response("<html><body>New document ready</body></html>", { headers: { "content-type": "text/html" } });
      return new Response(`<html><body>Loading<script src="/calendar.js"></script><script>(async()=>{
        for(let n=0;n<8;n++)await fetch('${api}get-business-info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hall_code:'publicHall'})});
        await fetch('${api}hall-widget',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hall_code:'publicHall',start_date:'2026-10-16',end_date:'2026-10-16',type:2})});
        ${change === "history" ? "history.replaceState(null,'','?sc=publicHall&view=calendar');" : ""}
        ${change === "navigation" ? "location.assign('/next');return;" : ""}
        ${change === "reload" ? "location.reload();return;" : ""}
        document.body.append('Calendar ready');
      })();</script></body></html>`, { headers: { "content-type": "text/html" } });
    }) as typeof global.fetch;
    const lease = (async (_host: string, work: () => Promise<unknown>) => ({ acquired: true, value: await work() })) as never;
    const task = collectInteractiveSimulatorResearch({ url: "https://passfactory.com/ftbb/publicFacility/?sc=publicHall", channel, assertOwned: async () => {} }, { fetch, lease });
    let terminalError: unknown;
    const settled = task.then(value => ({ value }), error => { terminalError = error; return { error }; });
    let sequence = 0;
    try {
      for (; sequence < 8; sequence++) {
        let view;
        // Match the bridge's bounded response window, not an arbitrary five
        // seconds that hides real navigation/capture errors behind fixture timeouts.
        const responseDeadline = Date.now() + 80_000;
        while (Date.now() < responseDeadline) {
          if (terminalError) throw terminalError;
          try { view = JSON.parse(await readFile(join(channel, `response-${sequence}.json`), "utf8")); break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await new Promise(r => setTimeout(r, 25)); }
        }
        if (!view) throw new Error("Fixture response timeout");
        if (view.text.includes(change === "navigation" || change === "reload" ? "New document ready" : "Calendar ready") && !view.loading) break;
        await writeFile(join(channel, `request-${sequence + 1}.json`), JSON.stringify({ action: "observe" }));
      }
      await writeFile(join(channel, `request-${sequence + 1}.json`), JSON.stringify({ action: "finish" }));
      const result = await task;
      expect(result.renderComplete).toBe(true);
      if (change === "navigation" || change === "reload") {
        expect(result.responseContracts).toHaveLength(0);
        expect(result.publicCalendarEvidence).toBeUndefined();
        expect(result.clientCodeEvidence).toBeUndefined();
      } else {
        expect(result.responseContracts).toHaveLength(8);
        expect(result.publicCalendarEvidence).toMatchObject([{ kind: "HALL", code: "publicHall", rule_times: [{
        availabilities: [{ table_id: "publicTable", slot_duration: 60, availability_type: 2 }],
        }] }]);
        expect(result.clientCodeEvidence?.fragments.some(fragment => fragment.code.includes("loadAvailability"))).toBe(true);
      }
      expect(visited).toHaveLength(change === "navigation" || change === "reload" ? 12 : 11);
    } finally {
      await writeFile(join(channel, `request-${sequence + 1}.json`), JSON.stringify({ action: "finish" })).catch(() => {});
      await settled;
      if (!channel.startsWith(resolve(".codex-artifacts/browser") + "/") && !channel.startsWith(resolve(".codex-artifacts/browser") + "\\")) throw new Error("Bad fixture path");
      await rm(channel, { recursive: true, force: true });
    }
  }, 90_000);

  it.each([
    { loseOwnership: false, phase: "content" },
    { loseOwnership: false, phase: "screenshot" },
    { loseOwnership: true, phase: "content" },
  ])("handles document changes without retrying lost ownership ($phase, lost=$loseOwnership)", async ({ loseOwnership, phase }) => {
    const channel = resolve(".codex-artifacts/browser", `fixture-${randomUUID()}`);
    await mkdir(channel, { recursive: true });
    const browser = await chromium.launch({ headless: true });
    const newContext = browser.newContext.bind(browser);
    let changed = false;
    let ownershipFailures = 0;
    const ownershipError = new Error("Fixture ownership lost");
    vi.spyOn(browser, "newContext").mockImplementation(async options => {
      const context = await newContext(options);
      const newPage = context.newPage.bind(context);
      vi.spyOn(context, "newPage").mockImplementation(async () => {
        const page = await newPage(), content = page.content.bind(page);
        vi.spyOn(page, "content").mockImplementation(async () => {
          const html = await content();
          if (!changed && phase === "content") { changed = true; await page.goto("https://public.example.test/next"); }
          return html;
        });
        const screenshot = page.screenshot.bind(page);
        vi.spyOn(page, "screenshot").mockImplementation(async options => {
          if (!changed && phase === "screenshot") {
            changed = true;
            await page.goto("https://public.example.test/next");
            throw new Error("page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot");
          }
          return screenshot(options);
        });
        return page;
      });
      return context;
    });
    const fetch = vi.fn(async (url: Parameters<typeof global.fetch>[0]) => new Response(String(url).endsWith("/next")
      ? "<html><body>New public document</body></html>"
      : "<html><body>Login required to view availability</body></html>", { headers: { "content-type": "text/html" } })) as typeof global.fetch;
    const lease = (async (_host: string, work: () => Promise<unknown>) => ({ acquired: true, value: await work() })) as never;
    const task = collectInteractiveSimulatorResearch({ url: "https://public.example.test/", channel, assertOwned: async () => {
      if (changed && loseOwnership) { ownershipFailures++; throw ownershipError; }
    } },
      { fetch, lease, launch: async () => browser });
    const settled = task.then(value => ({ value }), error => ({ error }));
    try {
      if (loseOwnership) {
        await expect(task).rejects.toBe(ownershipError);
        expect(ownershipFailures).toBe(1);
        expect(fetch).toHaveBeenCalledTimes(2);
        return;
      }
      let view;
      for (let attempt = 0; attempt < 400; attempt++) {
        try { view = JSON.parse(await readFile(join(channel, "response-0.json"), "utf8")); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await new Promise(r => setTimeout(r, 25)); }
      }
      expect(view?.text).toBe("New public document");
      expect(view?.accessControls).toEqual([]);
      await writeFile(join(channel, "request-1.json"), JSON.stringify({ action: "finish" }));
      expect((await task).accessControls).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await writeFile(join(channel, "request-1.json"), JSON.stringify({ action: "finish" })).catch(() => {});
      await settled;
      if (!channel.startsWith(resolve(".codex-artifacts/browser") + "/") && !channel.startsWith(resolve(".codex-artifacts/browser") + "\\")) throw new Error("Bad fixture path");
      await rm(channel, { recursive: true, force: true });
    }
  }, 20_000);

  it("runs an isolated real browser with visual feedback and interactive duration selection", async () => {
    const channel = resolve(".codex-artifacts/browser", `fixture-${randomUUID()}`);
    await mkdir(channel, { recursive: true });
    const visited: string[] = [];
    const assertOwned = vi.fn(async () => {});
    const html = `<html><body><h1>Public simulator fixture</h1>
      <label for="duration">Duration</label><select id="duration"><option>30 minutes</option><option>60 minutes</option></select>
      <button id="next">Next month</button><div id="state">October</div><button>1:00 PM</button>
      <label for="find">Search courses</label><input id="find" type="search"><div id="found"></div>
      <div><label>Party size</label><div><div id="party" role="combobox" tabindex="0" aria-haspopup="listbox">Choose</div><input aria-hidden="true" tabindex="-1"></div></div>
      <div id="party-options" role="listbox" hidden><div role="option">2 players</div></div>
      <div><label>Duration</label><div role="combobox" aria-haspopup="listbox">Ambiguous first</div><div role="combobox" aria-haspopup="listbox">Ambiguous second</div></div>
      <div><label for="different-field">Duration</label><div role="combobox" aria-haspopup="listbox">Wrong label</div></div>
      <button>Confirm reservation</button><a href="/login">Login</a>
      <script>async function loadAvailability(){const token='private-token-value';return fetch('/api/availability')}
      document.querySelector('#duration').onchange=e=>document.querySelector('#state').textContent=e.target.value;
      document.querySelector('#next').onclick=()=>{document.querySelector('#state').textContent='November';document.querySelector('#duration').selectedIndex=-1};
      document.querySelector('#find').oninput=e=>document.querySelector('#found').textContent=e.target.value;
      document.querySelector('#party').onclick=()=>document.querySelector('#party-options').hidden=false;
      document.querySelector('[role=option]').onclick=()=>{document.querySelector('#party').textContent='2 players selected';document.querySelector('#party-options').hidden=true};
      fetch('/graphql',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'query Calendar { slots { time } }'})});
      fetch('https://forms-na2.hscollectedforms.net/collected-forms/v1/config/json?portalId=123&utk=abcdef0123456789abcdef0123456789').catch(()=>{});
      fetch('https://track-na2.hubspot.com/__ptc.gif?utk=abcdef0123456789abcdef0123456789').catch(()=>{});</script>
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
      expect(second.selectedCalendarFilters).toContainEqual({ label: "Duration", value: "60 minutes" });
      const search = second.controls.find((control: { kind: string }) => control.kind === "field");
      await writeFile(join(channel, "request-2.json"), JSON.stringify({ action: "fill", target: search.target, text: "Public course" }));
      const third = await wait(2);
      expect(third.text).toContain("Public course");
      const next = third.controls.find((control: { name: string }) => control.name === "Next month");
      await writeFile(join(channel, "request-3.json"), JSON.stringify({ action: "click", target: next.target }));
      const fourth = await wait(3);
      expect(fourth.text).toContain("November");
      expect(fourth.selectedCalendarFilters).toContainEqual({ label: "Duration", value: "" });
      const party = fourth.controls.find((control: { kind: string; label: string }) => control.kind === "filter" && control.label === "Party size");
      expect(party).toBeDefined();
      expect(fourth.controls.some((control: { name: string }) => /Ambiguous|Wrong label/.test(control.name))).toBe(false);
      expect(fourth.controls.some((control: { kind: string }) => control.kind === "option")).toBe(false);
      await writeFile(join(channel, "request-4.json"), JSON.stringify({ action: "click", target: party.target }));
      const fifth = await wait(4);
      const option = fifth.controls.find((control: { kind: string; name: string }) => control.kind === "option" && control.name === "2 players");
      expect(option).toBeDefined();
      await writeFile(join(channel, "request-5.json"), JSON.stringify({ action: "click", target: option.target }));
      expect((await wait(5)).text).toContain("2 players selected");
      await writeFile(join(channel, "request-6.json"), JSON.stringify({ action: "finish" }));
      const result = await task;
      expect(result.text).toContain("November");
      expect(result.method).toBe("BROWSER");
      expect(result.renderComplete).toBe(true);
      expect(result.blockedRequests).toBeGreaterThan(0);
      expect(result.renderWarning).toBeUndefined();
      expect(result.responseContracts).toHaveLength(1);
      expect(result.selectedCalendarFilters).toContainEqual({ label: "Duration", value: "" });
      expect(result.selectedCalendarFilters).toContainEqual({ label: "Party size", value: "2 players selected" });
      expect(result.clientCodeEvidence?.fragments.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.clientCodeEvidence)).not.toContain("private-token-value");
      expect(visited).toEqual(["https://public.example.test/calendar", "https://public.example.test/graphql"]);
      expect(assertOwned.mock.calls.length).toBeGreaterThanOrEqual(5);
    } finally {
      // The known fixture directory is always beneath the private browser root.
      if (!channel.startsWith(resolve(".codex-artifacts/browser") + "/") && !channel.startsWith(resolve(".codex-artifacts/browser") + "\\")) throw new Error("Bad fixture path");
      await rm(channel, { recursive: true, force: true });
    }
  }, 25_000);
});
