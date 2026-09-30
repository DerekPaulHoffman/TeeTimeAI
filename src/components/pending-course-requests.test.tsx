import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingRecoveryDemandView } from "@/lib/course-recovery/demand";
import { PendingCourseRequests } from "./pending-course-requests";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const original: PendingRecoveryDemandView = {
  id: "demand-original", requestId: "request-original", courseName: "Original Public Links", town: "Seabrook, NH",
  date: "2099-10-03", startTime: "09:00", endTime: "12:00", players: 2,
  status: "WAITING", teeSearchId: null, revision: 1, expiresAt: "2099-10-05T00:00:00.000Z", message: "Your alert settings are saved."
};
const other = { ...original, id: "demand-other", requestId: "request-other", courseName: "Another Public Course", town: "Hampton, NH" };

describe("dashboard pending course requests", () => {
  afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it("shows original settings and cancels only the chosen request without sending account authority", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ demand: { ...original, status: "CANCELLED", revision: 2 } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<PendingCourseRequests demands={[original, other]} />);
    expect(screen.getAllByText("Oct 3, 2099")).toHaveLength(2);
    expect(screen.getAllByText("9:00 AM – 12:00 PM")).toHaveLength(2);
    expect(screen.getByText(/not checking tee times yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel saved alert request for Original Public Links" }));
    await screen.findByText("Original Public Links's saved alert request was cancelled.");
    expect(screen.queryByRole("heading", { name: original.courseName })).toBeNull();
    expect(screen.getByRole("heading", { name: other.courseName })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/courses/recovery/request-original/demand", { method: "DELETE" });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("refreshes an activation race without claiming the request was cancelled", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "This alert has already started. Manage it on your dashboard." }, { status: 400 })));
    render(<PendingCourseRequests demands={[original]} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel saved alert request for Original Public Links" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("already started");
    expect(screen.getByRole("heading", { name: original.courseName })).toBeTruthy();
    expect(screen.queryByText(/was cancelled/)).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps cancellation unconfirmed when the service is unavailable and offers refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Private database infrastructure detail" }, { status: 503 })));
    render(<PendingCourseRequests demands={[original]} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel saved alert request for Original Public Links" }));
    await screen.findByText("We couldn't cancel this saved request right now. Refresh the dashboard and try again.");
    expect(screen.queryByText("Private database infrastructure detail")).toBeNull();
    expect(screen.getByRole("heading", { name: original.courseName })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("accepts the refreshed server snapshot instead of retaining stale cancellation state", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ demand: { ...original, status: "CANCELLED", revision: 2 } })));
    const mounted = render(<PendingCourseRequests demands={[original, other]} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel saved alert request for Original Public Links" }));
    await screen.findByText(/was cancelled/);
    mounted.rerender(<PendingCourseRequests demands={[{ ...original, revision: 3 }, other]} />);
    expect(screen.getByRole("heading", { name: original.courseName })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel saved alert request for Original Public Links" }).hasAttribute("disabled")).toBe(false));
  });
});
