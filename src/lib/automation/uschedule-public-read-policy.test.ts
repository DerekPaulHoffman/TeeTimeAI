import { describe, expect, it } from "vitest";
import { createUSchedulePublicReadPolicy, hasUScheduleSimBookingDescription, isUSchedulePublicRentalLabel,
  isUScheduleSimBookingLabel } from "./uschedule-public-read-policy";

const source = "https://clients.uschedule.com/example-golf/booking";
const html = `<select id="select_service"><option value="72">Hourly Simulator Rental - Standard</option><option value="73">Golf Lessons</option></select>
  <select id="select_length"><option value="60">1 hour</option><option value="90">90 minutes</option></select>
  <select id="select_group_size"><option value="1">1</option><option value="4">4</option></select>
  <select id="select_service_type"><option value="0">All Services</option><option value="28">Standard Bay rental</option></select>`;
const headers = () => new Headers({ "content-type": "application/json", origin: "https://clients.uschedule.com", referer: source });
const body = (Name: string, Value: string) => JSON.stringify([{ Name, Value }]);
function setup(url = source, document = html) {
  const policy = createUSchedulePublicReadPolicy();
  expect(policy.observeResponse(url, "GET", 200, "text/html; charset=utf-8", document)).toBe(true);
  return policy;
}
describe("observed USchedule public filter reads", () => {
  it("recognizes an explicitly public non-member rental without admitting member services", () => {
    for (const label of ["Public/Non-Member Simulator Rental", "Public / Non Member Bay Rentals"])
      expect(isUSchedulePublicRentalLabel(label)).toBe(true);
    for (const label of ["Member Simulator Rental", "Public Member Simulator Rental", "Non-Member Simulator Rental Membership", "Public/Non-Member Simulator Rental Lesson", "Private/Non-Member Simulator Rental"])
      expect(isUSchedulePublicRentalLabel(label)).toBe(false);
  });
  it("admits only the exact public tee-times label inside the existing simulator rental policy", () => {
    for (const label of ["Public Tee Times", " public  tee times ", "PUBLIC TEE TIMES"]) expect(isUSchedulePublicRentalLabel(label)).toBe(true);
    for (const label of ["Tee Times", "Private Public Tee Times", "Public Tee Times Lesson", "Public Tee Times Package", "Members Public Tee Times", "Public Tee Times Checkout"]) expect(isUSchedulePublicRentalLabel(label)).toBe(false);
    const policy = setup(source, html.replace("Hourly Simulator Rental - Standard", "Public Tee Times")), endpoint = new URL(`${source}/changefield`);
    expect(policy.allows(endpoint, headers(), body("service_id", "72"))).toBe(true);
    expect(policy.allows(endpoint, headers(), body("service_id", "73"))).toBe(false);
    expect(policy.allows(endpoint, headers(), body("group_size", "4"))).toBe(false);
    expect(policy.allows(endpoint, headers(), body("time", "10:00"))).toBe(false);
  });
  it("requires visible simulator play or practice corroboration for the exact generic Sim Booking option", () => {
    const description = '<div id="serviceDescription" class="p-3 my-2"><div><span>Play or Practice for one hour on our SIMULATOR</span></div></div>';
    const booking = `<body class="anotherstudio"><select id="select_service"><option value="25395" selected>Sim Booking</option>
      <option value="25396">30 Minute Quick Practice Session</option></select><select id="select_length"><option value="60" selected>1 hour</option></select>${description}</body>`;
    expect(isUScheduleSimBookingLabel(" sim   booking ")).toBe(true);
    expect(isUSchedulePublicRentalLabel("Sim Booking")).toBe(true);
    expect(hasUScheduleSimBookingDescription(booking)).toBe(true);
    const bookingUrl = "https://clients.uschedule.com/anotherstudio/booking";
    const policy = createUSchedulePublicReadPolicy();
    expect(policy.observeResponse(bookingUrl, "GET", 200, "text/html", booking)).toBe(true);
    const h = new Headers({ "content-type": "application/json", origin: new URL(bookingUrl).origin, referer: bookingUrl });
    expect(policy.allows(new URL(`${bookingUrl}/changefield`), h, body("service_id", "25395"))).toBe(true);
    expect(policy.allows(new URL(`${bookingUrl}/changefield`), h, body("service_id", "25396"))).toBe(false);
    for (const label of ["Sim Booking Lesson", "Private Sim Booking", "Sim Booking Event", "Sim Booking Checkout", "Sim Booking Package", "Sim Booking Membership"])
      expect(isUSchedulePublicRentalLabel(label)).toBe(false);
    for (const invalid of [
      booking.replace(description, ""),
      booking.replace("Play or Practice for one hour on our SIMULATOR", "Golf lesson on our simulator"),
      booking.replace("Play or Practice for one hour on our SIMULATOR", "Play or Practice for a private simulator event"),
      booking.replace('id="serviceDescription"', 'id="otherDescription"'),
      booking.replace('class="p-3 my-2"', 'hidden'),
      booking.replace(description, description + description),
    ]) {
      expect(hasUScheduleSimBookingDescription(invalid)).toBe(false);
      const denied = createUSchedulePublicReadPolicy();
      expect(denied.observeResponse(bookingUrl, "GET", 200, "text/html", invalid)).toBe(false);
    }
  });
  it("requires a successful actual booking document and generalizes tenant and service IDs", () => {
    const policy = createUSchedulePublicReadPolicy();
    const endpoint = new URL(`${source}/changefield`);
    expect(policy.allows(endpoint, headers(), body("length", "60"))).toBe(false);
    expect(policy.observeResponse(source, "GET", 403, "text/html", html)).toBe(false);
    expect(policy.observeResponse(source, "GET", 200, "application/json", html)).toBe(false);
    expect(policy.observeResponse(source, "GET", 200, "text/html", html)).toBe(true);
    expect(policy.allows(endpoint, headers(), body("length", "60"))).toBe(true);
    const other = "https://clients.uschedule.com/another-golf/booking";
    const second = setup(other, html.replace('value="72"', 'value="981"'));
    const h = headers(); h.set("referer", other);
    expect(second.allows(new URL(`${other}/changefield`), h, body("service_id", "981"))).toBe(true);
    expect(second.allows(new URL(`${other}/changefield`), h, body("service_id", "72"))).toBe(false);
  });
  it("allows real bounded date and current rental options, keeping party context at one bay", () => {
    const policy = setup(), endpoint = new URL(`${source}/changefield`);
    for (const [key, value] of [["start_date", "10/23/2026"], ["length", "90"], ["service_id", "72"], ["service_type_id", "28"], ["group_size", "1"]])
      expect(policy.allows(endpoint, headers(), body(key, value))).toBe(true);
    for (const [key, value] of [["start_date", "02/30/2026"], ["start_date", "2026-10-23"], ["length", "120"], ["service_id", "73"], ["group_size", "4"]])
      expect(policy.allows(endpoint, headers(), body(key, value))).toBe(false);
    expect(policy.allows(new URL(`${source}/getavailabledates`), headers(), JSON.stringify({ date: "2026-11-01" }))).toBe(true);
    expect(policy.allows(new URL(`${source}/getavailabledates`), headers(), JSON.stringify({ date: "2026-11-02" }))).toBe(false);
  });
  it("rejects time, cart, payment, resources, PII, unexpected fields, and compound operations", () => {
    const policy = setup(), endpoint = new URL(`${source}/changefield`);
    for (const name of ["time", "payment", "addon", "resource", "private", "customer", "email", "more_next_avail"])
      expect(policy.allows(endpoint, headers(), body(name, "60"))).toBe(false);
    for (const value of [[{ Name: "length", Value: "60", time: "0900" }], [{ Name: "length", Value: "60" }, { Name: "time", Value: "0900" }], { Name: "length", Value: "60" }])
      expect(policy.allows(endpoint, headers(), JSON.stringify(value))).toBe(false);
    expect(policy.allows(new URL(`${source}/payment`), headers(), body("length", "60"))).toBe(false);
  });
  it("binds origin/referer and rejects credentials or framework action overrides", () => {
    const policy = setup(), endpoint = new URL(`${source}/changefield`);
    for (const [key, value] of [["origin", "https://other.example"], ["referer", `${source}?other=1`], ["referer", "https://clients.uschedule.com/other/booking"],
      ["authorization", "Bearer nope"], ["cookie", "session=nope"], ["next-action", "nope"]]) {
      const h = headers(); h.set(key, value); expect(policy.allows(endpoint, h, body("length", "60"))).toBe(false);
    }
    const h = new Headers({ "content-type": "application/json", origin: endpoint.origin });
    expect(policy.addReadHeaders(endpoint, "POST", { referer: source, "x-requested-with": "XMLHttpRequest" }, h, body("length", "60"))).toBe(true);
    expect(h.get("referer")).toBe(source);
    expect(h.has("cookie")).toBe(false);
  });
  it("retires observed options when a subsequent source document loses the public rental", () => {
    const policy = setup();
    expect(policy.observeResponse(source, "GET", 200, "text/html", "<h1>Sign in</h1>")).toBe(false);
    expect(policy.allows(new URL(`${source}/changefield`), headers(), body("length", "60"))).toBe(false);
  });
});
