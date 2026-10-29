import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnownTeeTimes, SimulatorSessions, useCourseTimeChecks, CourseTimeCheckStatus } from "./known-tee-times";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const time = { startsAt: "2026-10-02T14:00:00Z", availableSpots: 3, holes: 18,
  priceCents: 4500, bookingUrl: "https://example.com/tee-times", confirmedAt: "2026-10-02T13:55:00Z" };
const props = { times: [time], timeZone: "America/New_York", date: "2026-10-02", startTime: "09:00", endTime: "11:00", players: 2 };
describe("known tee-time links", () => {
  it("renders full simulator intervals in venue time without outdoor capacity, holes or price", () => {
    render(<SimulatorSessions sessions={[{ startsAt: time.startsAt, endsAt: "2026-10-02T15:00:00Z", bookingUrl: time.bookingUrl, confirmedAt: time.confirmedAt }]}
      timeZone={props.timeZone} date={props.date} startTime="09:00" endTime="11:00" durationMinutes={null} />);
    const region = screen.getByRole("region", { name: "Available simulator sessions" });
    expect(region.textContent).toContain("10:00 AM – 11:00 AM");
    expect(region.textContent).not.toMatch(/spots|holes|\$/);
    expect(screen.getByRole("link").getAttribute("href")).toBe(time.bookingUrl);
    expect(screen.getByRole("link").getAttribute("title")).toContain("60 minutes");
  });
  it("requires the entire session to fit and supports end-of-day midnight", () => {
    const sessions = [{ startsAt: "2026-10-03T03:00:00Z", endsAt: "2026-10-03T04:00:00Z", bookingUrl: time.bookingUrl, confirmedAt: time.confirmedAt }];
    const { rerender } = render(<SimulatorSessions sessions={sessions} timeZone={props.timeZone} date={props.date} startTime="23:00" endTime="24:00" durationMinutes={60} />);
    expect(screen.getByRole("link").textContent).toBe("11:00 PM – 12:00 AM");
    rerender(<SimulatorSessions sessions={sessions} timeZone={props.timeZone} date={props.date} startTime="23:00" endTime="23:59" durationMinutes={60} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/No matching sessions/)).toBeTruthy();
  });
  it("keeps unsupported simulator checks distinct from successfully checked empty sessions", () => {
    const { rerender } = render(<CourseTimeCheckStatus simulator check={{ status: "UNAVAILABLE", times: [] }} />);
    expect(screen.getByText("Live sessions aren't available here yet. Check the official site.")).toBeTruthy();
    expect(screen.queryByText(/No matching sessions/)).toBeNull();
    rerender(<CourseTimeCheckStatus simulator check={{ status: "FAILED", times: [] }} />);
    expect(screen.getByText("We couldn't check current sessions. Use the official site.")).toBeTruthy();
    rerender(<CourseTimeCheckStatus simulator check={{ status: "UNSUPPORTED_DURATION", times: [] }} />);
    expect(screen.getByText("No supported session length fits these filters. Change the time window or session length.")).toBeTruthy();
    expect(screen.queryByText(/No matching sessions/)).toBeNull();
  });
  it("uses offering-scoped session reads and invalidates old data when the session length changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ status: "CHECKED", times: [], sessions: [] }));
    vi.stubGlobal("fetch", fetchMock);
    function Harness({ duration }: { duration: number | null }) {
      const checks = useCourseTimeChecks(["rental"], "2026-10-03", 1, 0, undefined,
        { startTime: "09:00", endTime: "12:00", durationMinutes: duration });
      return <CourseTimeCheckStatus simulator check={checks.rental} />;
    }
    const { rerender } = render(<Harness duration={null} />);
    await waitFor(() => expect(screen.getByText("Sessions checked just now")).toBeTruthy());
    const firstUrl = new URL(fetchMock.mock.calls[0][0], "https://example.com");
    expect(firstUrl.pathname).toBe("/api/courses/check-sessions");
    expect(firstUrl.searchParams.get("offeringId")).toBe("rental");
    expect(firstUrl.searchParams.has("courseId")).toBe(false);
    expect(firstUrl.searchParams.has("durationMinutes")).toBe(false);
    fetchMock.mockImplementation(() => new Promise(() => {}));
    rerender(<Harness duration={120} />);
    expect(screen.queryByText("Sessions checked just now")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(new URL(fetchMock.mock.calls[1][0], "https://example.com").searchParams.get("durationMinutes")).toBe("120");
  });
  it("uses the known phone-only action when a live check is unavailable", () => {
    const { rerender } = render(<CourseTimeCheckStatus check={{ status: "UNAVAILABLE", times: [] }} alertSupport="PHONE_ONLY" />);
    expect(screen.getByText("Call the course for tee times.")).toBeTruthy();
    expect(screen.queryByText(/couldn't check/)).toBeNull();
    expect(screen.queryByText(/No matching/)).toBeNull();
    rerender(<CourseTimeCheckStatus check={{ status: "FAILED", times: [] }} alertSupport="PHONE_ONLY" />);
    expect(screen.getByText("We couldn't check current tee times. Use the official site.")).toBeTruthy();
    expect(screen.queryByText("Call the course for tee times.")).toBeNull();
  });
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
    expect(screen.getByTestId("good").textContent).toContain("Checking latest tee times");
    expect(screen.getByTestId("good").querySelector(".course-check-spinner")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("bad").textContent).toContain("couldn't check");
    expect(screen.getByTestId("bad").querySelector(".course-check-spinner")).toBeNull();
    await act(async () => complete!(Response.json({ status: "CHECKED", times: [time] })));
    await waitFor(() => expect(screen.getByTestId("good").textContent).toContain("checked just now"));
    expect(screen.getByTestId("good").querySelector(".course-check-spinner")).toBeNull();
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
