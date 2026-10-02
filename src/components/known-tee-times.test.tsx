import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnownTeeTimes, useCourseTimeChecks, CourseTimeCheckStatus } from "./known-tee-times";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const time = { startsAt: "2026-10-02T14:00:00Z", availableSpots: 3, holes: 18,
  priceCents: 4500, bookingUrl: "https://example.com/tee-times", confirmedAt: "2026-10-02T13:55:00Z" };
const props = { times: [time], timeZone: "America/New_York", date: "2026-10-02", startTime: "09:00", endTime: "11:00", players: 2 };
describe("known tee-time links", () => {
  it("checks each course independently and completes the successful course while another fails", async () => {
    let complete: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string) => url.includes("courseId=good") ? new Promise<Response>(resolve => { complete = resolve; }) : Promise.reject(new Error("provider failed")));
    vi.stubGlobal("fetch", fetchMock);
    function Harness() {
      const checks = useCourseTimeChecks(["good", "bad"], "2026-10-03", 4, 0);
      return <><div data-testid="good"><CourseTimeCheckStatus check={checks.good} /></div><div data-testid="bad"><CourseTimeCheckStatus check={checks.bad} /></div></>;
    }
    render(<Harness />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("good").textContent).toContain("Checking tee times");
    expect(screen.getByTestId("bad").textContent).toContain("couldn't check");
    await act(async () => complete!(Response.json({ status: "CHECKED", times: [time] })));
    await waitFor(() => expect(screen.getByTestId("good").textContent).toContain("checked just now"));
  });
  it("shows an honest empty result after a completed check", () => {
    render(<KnownTeeTimes {...props} players={4} showEmpty />);
    expect(screen.getByText("No matching public tee times found for this date and time window.")).toBeTruthy();
  });
  it("shows local time, rate, capacity, freshness, and an official link", () => {
    render(<KnownTeeTimes {...props} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(time.bookingUrl);
    expect(link.textContent).toBe("10:00 AM");
    expect(link.getAttribute("title")).toContain("3 spots · 18 holes · $45.00");
    expect(link.getAttribute("title")).toContain("9:55 AM");
    expect(link.textContent).not.toContain("Checked");
  });
  it("hides slots outside the window or with too few spots without claiming no availability", () => {
    const { rerender } = render(<KnownTeeTimes {...props} players={4} />);
    expect(screen.queryByRole("link")).toBeNull();
    rerender(<KnownTeeTimes {...props} startTime="11:00" />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
