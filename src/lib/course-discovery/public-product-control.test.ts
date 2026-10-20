import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectPublicRentalProductElement } from "./public-product-control";

const lightspeed = (options = '<button id="hour">1 hour $40</button><button>1 hour 30 minutes $60</button><button>2 hours $80</button>') =>
  `<main><section id="bay1"><h2>Bay 1 Reservation</h2><div>${options}</div></section><section id="bay2"><h2>Bay 2 Reservation</h2><button>1 hour $40</button></section></main>`;
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
