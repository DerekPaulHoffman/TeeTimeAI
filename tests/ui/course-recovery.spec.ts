import { expect, test, type Page } from "@playwright/test";
import { installSyntheticNetworkFence } from "./helpers/synthetic-network-fence";

const candidate = {
  googlePlaceId: "synthetic-salt-marsh", name: "Salt Marsh Public Links",
  address: "10 Marsh Rd, Seabrook, NH", latitude: 42.88, longitude: -70.88,
  website: "https://example.com/salt-marsh", publicAccessStatus: "PUBLIC",
  timeZone: "America/New_York"
};
const queued = { id: "synthetic-recovery", status: "QUEUED",
  message: "Your course request is saved. We're checking its identity and official site.",
  question: null, course: null, nextAttemptAt: null };
const nearby = [1, 2].map((number) => ({ ...candidate, googlePlaceId: `existing-choice-${number}`, name: `Existing Public Course ${number}` }));

async function isolateApi(page: Page, mode: "journey" | "ambiguous" | "unavailable" | "unresolved") {
  let verified = false;
  let admitted = 0;
  const inputs: unknown[] = [];
  const pageErrors: string[] = [];
  const origin = new URL(process.env.UI_SMOKE_BASE_URL ?? `http://127.0.0.1:${process.env.UI_SMOKE_PORT ?? "3100"}`).origin;
  const { unexpected, shellReads } = await installSyntheticNetworkFence(page, origin);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => { window.sessionStorage.setItem("tee-time-spot:traffic-class", "TEST"); });
  // All provider and mutation requests are answered by isolated fixtures.
  await page.route(`${origin}/api/**`, async (route) => {
    const url = new URL(route.request().url());
    const request = route.request();
    const method = request.method();
    const hasOnlyQueryKeys = (keys: string[]) => [...url.searchParams.keys()].every((key) => keys.includes(key));
    let body: unknown;
    let status = 200;
    if (url.pathname === "/api/analytics/events" && method === "POST" && !url.search) { body = { event: { id: "synthetic-event" } }; status = 201; }
    else if (url.pathname === "/api/feedback" && method === "POST" && !url.search) { body = { feedback: { id: "synthetic-feedback" } }; status = 201; }
    else if (url.pathname === "/api/location/geocode" && method === "GET" && hasOnlyQueryKeys(["q"]) && url.searchParams.get("q") === "Seabrook, NH") body = { latitude: 42.88, longitude: -70.88 };
    else if (url.pathname === "/api/courses/discover" && method === "GET" && hasOnlyQueryKeys(["latitude", "longitude", "radiusMeters"]) && url.searchParams.has("latitude") && url.searchParams.has("longitude") && url.searchParams.has("radiusMeters")) body = { courses: nearby };
    else if (url.pathname === "/api/courses/lookup" && method === "GET" && hasOnlyQueryKeys(["q", "latitude", "longitude"]) && url.searchParams.has("q") && url.searchParams.has("latitude") === url.searchParams.has("longitude")) body = { courses: [] };
    else if (url.pathname === "/api/courses/recovery" && method === "POST" && !url.search) {
      inputs.push(request.postDataJSON());
      admitted++;
      status = admitted === 1 ? 201 : 200;
      if (mode === "unavailable") { status = 503; body = { error: "Synthetic infrastructure detail" }; }
      else if (mode === "ambiguous") body = { recovery: { ...queued, status: "NEEDS_DETAILS",
        message: "We found two facilities with similar names.", question: "Do you mean the course in Seabrook, NH or Seabrook, SC?" } };
      else if (mode === "unresolved") body = { recovery: { ...queued, status: "UNRESOLVED",
        message: "We couldn't establish this course's identity yet." } };
      else body = { recovery: queued };
    } else if (url.pathname === `/api/courses/recovery/${queued.id}` && method === "GET" && !url.search) body = {
      recovery: verified ? { ...queued, status: "VERIFIED", course: candidate, message: "This public course is verified." } : queued
    };
    else {
      unexpected.push(`${method} ${request.resourceType()} ${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { inputs, unexpected, shellReads, pageErrors, verify: () => { verified = true; } };
}

test.describe("isolated missing course recovery", () => {
  test.skip(Boolean(process.env.UI_SMOKE_BASE_URL) && !["localhost", "127.0.0.1"].includes(new URL(process.env.UI_SMOKE_BASE_URL!).hostname),
    "Synthetic recovery proof runs against an isolated local application.");

  test("retains repeat/reload requests and returns a selectable course without changing the shortlist", async ({ page }, testInfo) => {
    const fixture = await isolateApi(page, "journey");
    await page.clock.install();
    await page.goto("/search");
    await page.getByRole("textbox", { name: "Location", exact: true }).fill("Seabrook, NH");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("button", { name: "Add Existing Public Course 2" }).click();
    await page.getByRole("button", { name: "Add Existing Public Course 1" }).click();
    await page.getByRole("searchbox", { name: "Course name", exact: true }).fill(candidate.name);
    await page.getByRole("textbox", { name: "Course town or city" }).fill("Seabrook, NH");
    await page.getByRole("button", { name: "Find course" }).click();
    await expect(page.getByText(queued.message, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save alert request for this course" })).toHaveCount(0);
    await page.getByRole("button", { name: "Find course" }).click();
    await expect.poll(() => fixture.inputs.length).toBe(2);
    await expect(page.getByText(queued.message, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(queued.message, { exact: true })).toBeVisible();
    const receipt = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem("tee-time-spot-course-recovery")!));
    expect(receipt).toEqual({ id: queued.id, input: expect.objectContaining({ name: candidate.name, town: "Seabrook, NH" }) });
    fixture.verify();
    await page.clock.fastForward(15_001);
    await expect(page.getByRole("heading", { name: candidate.name, exact: true })).toBeVisible();
    await expect(page.locator(".selected-list .selected-row")).toHaveCount(2);
    await expect(page.getByRole("button", { name: `Add ${candidate.name}`, exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("recovered-selectable-course.png"), fullPage: true });
    await page.getByRole("button", { name: `Add ${candidate.name}`, exact: true }).click();
    const names = await page.locator(".selected-list .selected-row h3").allTextContents();
    expect(names).toEqual(["Existing Public Course 2", "Existing Public Course 1", candidate.name]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  });

  test("requires precise town and presents the actual identity ambiguity", async ({ page }) => {
    const fixture = await isolateApi(page, "ambiguous");
    await page.goto("/search");
    await page.getByRole("searchbox", { name: "Course name", exact: true }).fill(candidate.name);
    await page.getByRole("button", { name: "Find course" }).click();
    await expect(page.getByText("Enter the course's town or city so we can verify the right course.")).toBeVisible();
    expect(fixture.inputs).toHaveLength(0);
    await page.getByRole("textbox", { name: "Course town or city" }).fill("Seabrook");
    await page.getByRole("button", { name: "Find course" }).click();
    await expect(page.getByText("Do you mean the course in Seabrook, NH or Seabrook, SC?")).toBeVisible();
    await page.getByRole("button", { name: "Update course details" }).click();
    await expect(page.getByRole("searchbox", { name: "Course name", exact: true })).toBeFocused();
    await page.getByRole("textbox", { name: "Course town or city" }).fill("Seabrook, NH");
    await page.getByRole("textbox", { name: "Street address (optional)" }).fill("10 Marsh Rd");
    await page.getByRole("textbox", { name: "Official website (optional)" }).fill("https://example.com/salt-marsh");
    await page.getByRole("button", { name: "Find course" }).click();
    await expect.poll(() => fixture.inputs.length).toBe(2);
    expect(fixture.inputs[1]).toEqual({ name: candidate.name, town: "Seabrook, NH", address: "10 Marsh Rd", officialWebsite: "https://example.com/salt-marsh" });
    expect(fixture.unexpected).toEqual([]);
  });

  test("reports unavailable persistence honestly", async ({ page }) => {
    const fixture = await isolateApi(page, "unavailable");
    await page.goto("/search");
    await page.getByRole("searchbox", { name: "Course name", exact: true }).fill(candidate.name);
    await page.getByRole("textbox", { name: "Course town or city" }).fill("Seabrook, NH");
    await page.getByRole("button", { name: "Find course" }).click();
    await expect(page.getByText("We couldn't save a course investigation right now. Try Find course again in a moment.")).toBeVisible();
    await expect(page.getByText("Synthetic infrastructure detail")).toHaveCount(0);
    expect(await page.evaluate(() => window.sessionStorage.getItem("tee-time-spot-course-recovery"))).toBeNull();
    expect(fixture.unexpected).toEqual([]);
  });

  test("never treats an unresolved fictional lookup as nonexistence or a selectable course", async ({ page }) => {
    const fixture = await isolateApi(page, "unresolved");
    await page.goto("/search");
    await page.getByRole("searchbox", { name: "Course name", exact: true }).fill("Fictional Moonlight Links");
    await page.getByRole("textbox", { name: "Course town or city" }).fill("Seabrook, NH");
    await page.getByRole("button", { name: "Find course" }).click();
    await expect(page.getByText(/A missing result doesn't mean the course doesn't exist/)).toBeVisible();
    await expect(page.getByRole("list", { name: "Direct course matches" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save alert request for this course" })).toHaveCount(0);
    expect(fixture.unexpected).toEqual([]);
  });

  test("blocks unexpected local fetch, XHR and external provider calls before application I/O", async ({ page }) => {
    const fixture = await isolateApi(page, "journey");
    await page.goto("/search");
    const blocked = await page.evaluate(async () => {
      const results = await Promise.allSettled([
        fetch("/unexpected-product-reader"),
        fetch("https://unfamiliar-provider.example/availability"),
        new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open("POST", "/api/unexpected-mutation");
          request.onload = () => resolve("unexpected success");
          request.onerror = () => reject(new Error("request fenced"));
          request.send("synthetic");
        })
      ]);
      return results.map((result) => result.status);
    });
    expect(blocked).toEqual(["rejected", "rejected", "rejected"]);
    expect(fixture.unexpected).toHaveLength(3);
    expect(fixture.unexpected.some((request) => request.includes("GET fetch") && request.endsWith("/unexpected-product-reader"))).toBe(true);
    expect(fixture.unexpected.some((request) => request.includes("GET fetch https://unfamiliar-provider.example/availability"))).toBe(true);
    expect(fixture.unexpected.some((request) => request.includes("POST xhr") && request.endsWith("/api/unexpected-mutation"))).toBe(true);
  });

  test("permits pinned production shell prefetches while rejecting altered shell requests", async ({ page }) => {
    const fixture = await isolateApi(page, "journey");
    await page.goto("/search");
    const results = await page.evaluate(async () => {
      const headers = { rsc: "1", "next-router-prefetch": "1", "next-router-segment-prefetch": "/_tree" };
      const requests = [
        fetch("/search?_rsc=synthetic-shell", { headers }),
        fetch("/search?_rsc=synthetic-shell", { headers: { ...headers, "next-router-segment-prefetch": "/search/__PAGE__" } }),
        fetch("/search?_rsc=synthetic-shell", { headers: { ...headers, "next-router-segment-prefetch": "/unowned-segment" } }),
        fetch("/search?_rsc=synthetic-shell&product=unowned", { headers }),
        fetch("/search?_rsc=synthetic-shell&_rsc=duplicate", { headers }),
        fetch("/search?_rsc=synthetic-shell", { method: "POST", headers, body: "synthetic" }),
        fetch("/search?_rsc=synthetic-shell", { headers: { ...headers, "next-action": "unowned-action" } }),
        fetch("/search?_rsc=synthetic-shell", { headers: { ...headers, "next-router-state-tree": "[]", "next-router-segment-prefetch": "/unowned-segment" } }),
        fetch("/unowned-product-reader?_rsc=synthetic-shell", { headers })
      ];
      return (await Promise.allSettled(requests)).map((result) => result.status);
    });
    expect(results).toEqual(["fulfilled", "fulfilled", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected"]);
    expect(fixture.shellReads).toContain("/search");
    expect(fixture.unexpected).toHaveLength(7);
    expect(fixture.unexpected.filter((request) => request.startsWith("POST fetch"))).toHaveLength(1);
  });
});
