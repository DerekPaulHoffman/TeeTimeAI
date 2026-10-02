import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KnownTeeTimes } from "./known-tee-times";

afterEach(cleanup);
const time = { startsAt: "2026-10-02T14:00:00Z", availableSpots: 3, holes: 18,
  priceCents: 4500, bookingUrl: "https://example.com/tee-times", confirmedAt: "2026-10-02T13:55:00Z" };
const props = { times: [time], timeZone: "America/New_York", date: "2026-10-02", startTime: "09:00", endTime: "11:00", players: 2 };
describe("known tee-time links", () => {
  it("shows local time, rate, capacity, freshness, and an official link", () => {
    render(<KnownTeeTimes {...props} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(time.bookingUrl);
    expect(link.textContent).toContain("10:00 AM EDT");
    expect(link.textContent).toContain("3 spots · 18 holes · $45.00");
    expect(link.textContent).toContain("Checked 9:55 AM EDT");
  });
  it("hides slots outside the window or with too few spots without claiming no availability", () => {
    const { rerender } = render(<KnownTeeTimes {...props} players={4} />);
    expect(screen.queryByRole("link")).toBeNull();
    rerender(<KnownTeeTimes {...props} startTime="11:00" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
