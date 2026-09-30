import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingRecoveryDemandView } from "@/lib/course-recovery/demand";
import { SearchEmailDeliveryInProgressError } from "@/lib/users/pending-email";
import { COURSE_RECOVERY_RECEIPT_KEY } from "@/components/course-recovery-panel";
import { TeeTimeIntake } from "@/components/tee-time-intake";
import DashboardPage from "./page";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), appUser: vi.fn(), database: vi.fn(), clerk: vi.fn(), searches: vi.fn(), pending: vi.fn(), refresh: vi.fn(), push: vi.fn()
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/auth/current-user", () => ({ getRequiredAppUser: mocks.appUser }));
vi.mock("@/lib/env", () => ({ hasDatabaseConfig: mocks.database, hasClerkConfig: mocks.clerk, getClerkPublishableKey: () => "synthetic-key" }));
vi.mock("@/lib/searches/service", () => ({ listTeeSearchesForUser: mocks.searches }));
vi.mock("@/lib/course-recovery/demand", () => ({ listPendingRecoveryDemandsForUser: mocks.pending }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/components/dashboard-sign-in-actions", () => ({ DashboardSignInActions: () => <button>Sign in</button> }));
vi.mock("@/components/search-status-actions", () => ({ SearchStatusActions: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh, push: mocks.push }) }));

const original: PendingRecoveryDemandView = {
  id: "demand-original", requestId: "request-original", courseName: "Original Public Links", town: "Seabrook, NH",
  date: "2099-10-03", startTime: "09:00", endTime: "12:00", players: 2,
  status: "WAITING", teeSearchId: null, revision: 1, expiresAt: "2099-10-05T00:00:00.000Z", message: "Your alert settings are saved."
};

describe("owner pending course requests on the dashboard", () => {
  beforeEach(() => {
    mocks.database.mockReturnValue(true); mocks.clerk.mockReturnValue(true);
    mocks.auth.mockResolvedValue({ userId: "clerk-owner" });
    mocks.appUser.mockResolvedValue({ id: "app-owner", email: "owner@example.com" });
    mocks.searches.mockResolvedValue([]); mocks.pending.mockResolvedValue([original]);
  });
  afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); window.sessionStorage.clear(); });

  it.each([
    ["database", "Dashboard setup needed"], ["clerk", "Account access is temporarily unavailable"],
    ["signed out", "Sign in to manage searches"], ["email transition", "Updating your alert email"]
  ])("does not load pending owner data when %s access is unavailable", async (gate, heading) => {
    if (gate === "database") mocks.database.mockReturnValue(false);
    if (gate === "clerk") mocks.clerk.mockReturnValue(false);
    if (gate === "signed out") mocks.auth.mockResolvedValue({ userId: null });
    if (gate === "email transition") mocks.appUser.mockRejectedValue(new SearchEmailDeliveryInProgressError());
    render(await DashboardPage());
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    expect(mocks.pending).not.toHaveBeenCalled();
    expect(mocks.searches).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: original.courseName })).toBeNull();
  });

  it("loads only the mapped account's durable requests without needing a browser receipt", async () => {
    render(await DashboardPage());
    expect(mocks.pending).toHaveBeenCalledExactlyOnceWith("app-owner");
    expect(mocks.searches).toHaveBeenCalledExactlyOnceWith("app-owner");
    expect(screen.getByRole("heading", { name: "Pending course requests" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: original.courseName })).toBeTruthy();
    expect(screen.getByText(original.town)).toBeTruthy();
    expect(screen.getByText("Oct 3, 2099")).toBeTruthy();
    expect(document.body.textContent).not.toContain("owner@example.com");
    expect(window.sessionStorage.getItem(COURSE_RECOVERY_RECEIPT_KEY)).toBeNull();
  });

  it("keeps original waiting intent reachable after a new identity replaces the receipt, reloads, and cancels only the original", async () => {
    const waiting = new Map<string, PendingRecoveryDemandView>();
    const other = { ...original, id: "demand-other", requestId: "request-other", courseName: "Another Public Course", town: "Hampton, NH" };
    waiting.set(other.requestId, other);
    mocks.pending.mockImplementation(async () => [...waiting.values()]);
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      if (path.startsWith("/api/courses/lookup?") && !init?.method) return Response.json({ courses: [] });
      if (path === "/api/courses/recovery" && init?.method === "POST") {
        const { name } = JSON.parse(String(init.body));
        return Response.json({ recovery: { id: name === original.courseName ? original.requestId : "request-corrected", status: "QUEUED",
          message: "Your course request is saved.", question: null, course: null, nextAttemptAt: null } }, { status: 201 });
      }
      const requestId = path.match(/^\/api\/courses\/recovery\/(request-original|request-corrected)\/demand$/)?.[1];
      if (requestId && init?.method === "POST") {
        expect(requestId).toBe(original.requestId);
        waiting.set(requestId, original);
        return Response.json({ demand: original });
      }
      if (requestId && init?.method === "DELETE") {
        waiting.delete(requestId);
        return Response.json({ demand: { ...original, status: "CANCELLED", revision: 2 } });
      }
      if (requestId && !init?.method) return Response.json({ demand: waiting.get(requestId) ?? null });
      if (["/api/feedback", "/api/analytics/events"].includes(path) && init?.method === "POST") return Response.json({ id: "synthetic" }, { status: 201 });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const intake = render(<TeeTimeIntake accountEnabled accountSignedIn accountEmail="owner@example.com"
      initialValues={{ location: original.town, date: original.date, startTime: original.startTime, endTime: original.endTime, players: original.players }} />);
    fireEvent.change(screen.getByLabelText("Course name"), { target: { value: original.courseName } });
    fireEvent.click(screen.getByRole("button", { name: "Find course" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save alert request for this course" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save alert request for this course" }));
    await screen.findByRole("button", { name: "Cancel saved alert request" });
    expect(screen.getByText(/Saved requests stay active when you browse or correct another course/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage saved course requests on your dashboard" }).getAttribute("href")).toBe("/dashboard");

    fireEvent.change(screen.getByLabelText("Course name"), { target: { value: "Corrected Public Links" } });
    fireEvent.change(screen.getByLabelText("Course town or city"), { target: { value: "Exeter, NH" } });
    fireEvent.click(screen.getByRole("button", { name: "Find course" }));
    await screen.findByRole("heading", { name: "Course request · Corrected Public Links" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save alert request for this course" }).hasAttribute("disabled")).toBe(false));
    expect(JSON.parse(window.sessionStorage.getItem(COURSE_RECOVERY_RECEIPT_KEY)!).id).toBe("request-corrected");
    expect(fetchMock.mock.calls.filter(([path, init]) => String(path).endsWith("/demand") && init?.method === "POST")).toHaveLength(1);
    expect(waiting.get(original.requestId)).toEqual(original);
    expect(screen.getByRole("link", { name: "Manage saved course requests on your dashboard" }).getAttribute("href")).toBe("/dashboard");
    intake.unmount();
    window.sessionStorage.clear();

    const dashboard = render(await DashboardPage());
    expect(screen.getByRole("heading", { name: original.courseName })).toBeTruthy();
    expect(screen.getByText(original.town)).toBeTruthy();
    expect(screen.getAllByText("Oct 3, 2099")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Corrected Public Links" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: `Cancel saved alert request for ${original.courseName}` }));
    await screen.findByText("Original Public Links's saved alert request was cancelled.");
    expect(waiting.has(original.requestId)).toBe(false);
    expect(waiting.get(other.requestId)).toEqual(other);
    expect(screen.getByRole("heading", { name: other.courseName })).toBeTruthy();
    dashboard.unmount();
    render(await DashboardPage());
    expect(screen.queryByRole("heading", { name: original.courseName })).toBeNull();
    expect(screen.getByRole("heading", { name: other.courseName })).toBeTruthy();
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
