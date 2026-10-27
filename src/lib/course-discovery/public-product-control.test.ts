import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectPublicRentalProductElement } from "./public-product-control";

const lightspeed = (options = '<button id="hour">1 hour $40</button><button>1 hour 30 minutes $60</button><button>2 hours $80</button>') =>
  `<main><section id="bay1"><h2>Bay 1 Reservation</h2><div>${options}</div></section><section id="bay2"><h2>Bay 2 Reservation</h2><button>1 hour $40</button></section></main>`;
const advertised = (duration = "1 hr", title = "1 Hour Public Golf") => `<main><article id="product"><h4>${title}</h4><span>${duration}</span><span>$55</span>
  <p>55 mins of golfing. Five minutes is for sanitation and reset. Once the appointment is booked and paid for, public practice begins.</p>
  <span role="button" aria-haspopup="menu">More<span role="button" hidden>More</span></span><button id="hour">BOOK</button></article></main>`;
function inspect(html: string, selector = "#hour") {
  document.body.innerHTML = html;
  return inspectPublicRentalProductElement(document.querySelector(selector)!);
}

describe("bounded public rental products", () => {
  beforeEach(() => { vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 20, height: 20, top: 0, left: 0, right: 20, bottom: 20, toJSON: () => ({}) }); });
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ""; });

  it("identifies the Lightspeed duration/price option within its specific bay", () => {
    expect(inspect(lightspeed())).toEqual({ selector: '[id="bay1"]', durationMinutes: 60 });
    expect(inspect(lightspeed().replace('id="hour">1 hour $40', 'id="hour">1 hour 30 minutes $60').replace('<button>1 hour 30 minutes $60</button>', "")))
      .toEqual({ selector: '[id="bay1"]', durationMinutes: 90 });
  });
  it("retains Book/Select actions with exactly one proved duration", () => {
    for (const name of ["Book", "Select"]) expect(inspect(`<article id="product"><h2>Golf Time 1 HOUR</h2><p>1 hour</p><button id="hour">${name}</button></article>`))
      .toEqual({ selector: '[id="product"]', durationMinutes: 60 });
  });
  it("uses the exact advertised duration without confusing play-time prose with the whole rental", () => {
    expect(inspect(advertised())).toEqual({ selector: '[id="product"]', durationMinutes: 60 });
    expect(inspect(advertised("1 hr 55 mins", "2 Hour Public Golf"))).toEqual({ selector: '[id="product"]', durationMinutes: 115 });
    expect(inspect(advertised("<span>1 hr 55 mins</span>", "<span>2 hours</span> Public Golf"))).toEqual({ selector: '[id="product"]', durationMinutes: 115 });
    expect(inspect(advertised().replace('id="hour">BOOK', 'id="hour">SELECT'))).toEqual({ selector: '[id="product"]', durationMinutes: 60 });
  });
  it("does not choose between conflicting standalone advertised durations", () => {
    expect(inspect(advertised().replace("<span>$55</span>", "<span>90 minutes</span><span>$55</span>"))).toBeUndefined();
    expect(inspect(advertised().replace("<span>$55</span>", "<div><p>2 hours</p></div><span>$55</span>"))).toBeUndefined();
  });
  it.each(["hidden", "inert", 'style="display:none"', 'aria-hidden="true"'])("does not use a %s advertised duration", attribute => {
    expect(inspect(advertised().replace("<span>1 hr</span>", `<span ${attribute}>1 hr</span>`))).toBeUndefined();
  });
  it("does not borrow a duration from a heading, action descendant or unrelated nested field", () => {
    expect(inspect(advertised().replace("<span>1 hr</span>", "").replace("1 Hour Public Golf", "<span>1 hr</span> Public Golf"))).toBeUndefined();
    expect(inspect(advertised().replace("<span>1 hr</span>", '<span role="button">1 hr</span>'))).toBeUndefined();
    expect(inspect(advertised().replace("<span>1 hr</span>", '<div><input value="1 hr"><span>1 hr</span></div>'))).toBeUndefined();
  });
  it.each(["0 minutes", "14 minutes", "481 minutes", "1 hr 90 mins", "1 hr 30 secs"])("does not promote invalid advertised duration %s", duration => {
    expect(inspect(advertised(duration))).toBeUndefined();
  });
  it("retains all action, form, date, transaction and bounded-card guards for advertised products", () => {
    for (const html of [advertised().replace("<button id=", "<button>Select</button><button id="), advertised().replace('<h4>', '<h4 hidden>'),
      advertised().replace("<h4>", "<h3>Other service</h3><h4>"), advertised().replace("<article", "<form><article").replace("</article>", "</article></form>"),
      advertised().replace("<span>$55</span>", '<input type="email"><span>$55</span>'), advertised().replace("55 mins of golfing.", "Checkout now. 55 mins of golfing."),
      advertised().replace("55 mins of golfing.", "10:00 AM on 2030-01-02. 55 mins of golfing."),
      advertised().replace("<span>$55</span>", "<span></span>".repeat(129) + "<span>$55</span>")]) expect(inspect(html)).toBeUndefined();
  });
  it.each(["1 hour or 2 hours $40", "1 hour $40.9", "13 hours $40", "0 minutes $40", "1 hour 90 minutes $40", "1 hour $-40", "1 hour $40 Pay", "2026-10-23 1 hour $40", "10:00 AM 1 hour $40"])
    ("rejects malformed or time-bound button %s", text => { expect(inspect(lightspeed(`<button id="hour">${text}</button>`))).toBeUndefined(); });
  it.each(["Checkout", "Pay now", "Contact", "Member Simulator Rental", "Golf Lessons", "October 23, 2026", "10/23/2026", "10:00 AM"])
    ("rejects unsafe or scheduled card context %s", text => { expect(inspect(lightspeed().replace("Bay 1 Reservation", text))).toBeUndefined(); });
  it("rejects duplicates, mixed controls, or a broad wrapper spanning separate resource cards", () => {
    expect(inspect(lightspeed('<button id="hour">1 hour $40</button><button>1 hour $40</button>'))).toBeUndefined();
    expect(inspect(lightspeed('<button id="hour">1 hour $40</button><button>Next</button>'))).toBeUndefined();
    expect(inspect('<main id="page"><h1>Golf Simulator</h1><article><h2>Bay 1 Reservation</h2><button id="hour">1 hour $40</button><button>Next</button></article><article><h2>Bay 2 Reservation</h2><button>2 hours $80</button></article></main>')).toBeUndefined();
    expect(inspect('<article><h2>Golf Time</h2>1 hour 2 hours<button id="hour">Book</button></article>')).toBeUndefined();
    expect(inspect('<article><h2>Golf Time</h2>1 hour<button id="hour">Book</button><button>Select</button></article>')).toBeUndefined();
  });
  it("rejects hidden, disabled, transaction-ancestor, contact-form, and input-bearing products", () => {
    for (const html of [lightspeed().replace('id="hour"', 'id="hour" hidden'), lightspeed().replace('id="bay1"', 'id="bay1" style="opacity:0"'),
      lightspeed().replace('id="hour"', 'id="hour" disabled'), `<section aria-label="Checkout">${lightspeed()}</section>`,
      `<form><input type="email">${lightspeed()}</form>`, lightspeed().replace("<h2>Bay 1 Reservation</h2>", '<h2>Bay 1 Reservation</h2><input type="text">')]) expect(inspect(html)).toBeUndefined();
  });
  it("allows a uniquely labelled plain rental card without heading semantics", () => {
    expect(inspect('<div id="resource"><div>Bay 1 Reservation</div><div><button id="hour">60 minutes USD 40.00</button></div></div>'))
      .toEqual({ selector: '[id="resource"]', durationMinutes: 60 });
  });
  it.each(["https://example.org/checkout", "https://example.org/login", "https://example.org/products?token=secret", "https://example.org/reserve?teeTimeId=123",
    "https://example.org/review", "https://example.org/product?slot=123", "javascript:void(0)", "mailto:shop@example.org"])
    ("does not classify unsafe product link %s", href => {
      expect(inspect(`<article><h2>Bay 1 Reservation</h2><a id="hour" href="${href}">1 hour $40</a></article>`)).toBeUndefined();
    });
});
