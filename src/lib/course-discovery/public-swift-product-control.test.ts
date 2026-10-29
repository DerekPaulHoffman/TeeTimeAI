// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://book.runswiftapp.com/facilities/example-labs/rentals"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { inspectPublicRentalProductElement } from "./public-product-control";

const card = '<h5>Rentals</h5><button id="bay" type="button"><h6>Golf Sim 1 (Peak)</h6><h5>$70</h5><p>3 pm to 7 pm Monday-Friday 7 am to 7 pm Saturday &amp; Sunday</p><span>1 hour</span></button>';
const overview = '<div role="dialog"><h2><button aria-label="Back" type="button"></button><span>Overview</span><button aria-label="Close" type="button"></button></h2><h5>Golf Sim 1 (Peak)</h5><h6>PRICING</h6><p>1 hour - $70.00</p><h6>DESCRIPTION</h6><p>Private golf simulator bay for practice or lessons and fittings.</p><button id="bay" type="button">Book now</button></div>';
function inspect(html: string) { document.body.innerHTML = html; return inspectPublicRentalProductElement(document.getElementById("bay")!); }
describe("undated public Swift bay catalogue controls", () => {
  beforeEach(() => { vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, toJSON: () => ({}) }); });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });
  it.each([card, overview])("opens only the single-bay one-hour product or its undated overview", html => {
    expect(inspect(html)).toEqual({ selector: '[id="bay"]', durationMinutes: 60 });
  });
  it("executes as the serialized browser function without module-scoped transpiler helpers", () => {
    document.body.innerHTML = card;
    // The installed local browser helper uses tsx, whose function-name
    // transform differs from Vitest's. Exercise that actual serialization.
    const serialized = execFileSync(process.execPath, ["--require", "tsx/cjs", "-e",
      'const m=require("./src/lib/course-discovery/public-product-control.ts");process.stdout.write((m.inspectPublicRentalProductElement??m.default.inspectPublicRentalProductElement).toString())'],
    { cwd: process.cwd(), encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
    const remote = runInNewContext(`(${serialized})`, { document, getComputedStyle }) as typeof inspectPublicRentalProductElement;
    expect(remote(document.getElementById("bay")!)).toEqual({ selector: '[id="bay"]', durationMinutes: 60 });
  });
  it.each([
    card.replace("Golf Sim 1", "Golf Sim 1 &amp; 2"), card.replace("Golf Sim 1", "Ski Sim 1"),
    card.replace("1 hour", "2 hours"), card.replace("1 hour", "1 hour</span><span>2 hours"),
    card.replace("<span>1 hour</span>", ""), card.replace("<h5>Rentals</h5>", ""),
    card.replace("<button", "<form><button").replace("</button>", "</button></form>"),
    card.replace("<button", '<button hidden'), card.replace("<button", '<button onclick="holdSlot()"'),
    card.replace("3 pm", "10:00 AM"), card.replace("3 pm", "Oct 31"),
    overview.replace("Overview", "Choose Times"), overview.replace("Book now", "Confirm"),
    overview.replace("<h6>PRICING", '<input name="date"><h6>PRICING'),
    overview.replace("Book now", "Book now 10:00 AM"), overview.replace("1 hour -", "90 minutes -"),
    overview.replace("Golf Sim 1", "Golf Sim 1 &amp; 2"), overview.replace("<h6>DESCRIPTION", "<h5>Golf Sim 2</h5><h6>DESCRIPTION"),
  ])("rejects times, transactions, multiple resources and ambiguous products (case %#)", html => {
    expect(inspect(html)).toBeUndefined();
  });
  it("keeps the special catalogue rule off account and other routes", () => {
    window.history.replaceState({}, "", "/facilities/example-labs/create-account");
    try { expect(inspect(card)).toBeUndefined(); expect(inspect(overview)).toBeUndefined(); }
    finally { window.history.replaceState({}, "", "/facilities/example-labs/rentals"); }
  });
});
