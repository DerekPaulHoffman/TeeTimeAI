import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeeTimeIntake } from "./tee-time-intake";
import { COURSE_RECOVERY_RECEIPT_KEY } from "./course-recovery-panel";
import { clearSearchDraft, SEARCH_DRAFT_STORAGE_KEY } from "@/lib/searches/search-draft";
import type { RecoveryView } from "@/lib/course-recovery/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const account = { accountEnabled: true, accountSignedIn: true, accountEmail: "owner@example.com" };
const initialValues = { location: "Seabrook, NH", date: "2099-10-03", startTime: "09:00", endTime: "12:00", players: 2 };
const queued: RecoveryView = {
  id: "recovery-request", status: "QUEUED", message: "Your course request is saved. We're checking its identity and official site.",
  question: null, course: null, nextAttemptAt: null
};
const verifiedCourse = {
  googlePlaceId: "recovered-place", name: "Salt Marsh Public Links", address: "10 Marsh Rd, Seabrook, NH",
  latitude: 42.88, longitude: -70.88, website: "https://example.com/salt-marsh",
  timeZone: "America/New_York", publicAccessStatus: "PUBLIC" as const
};

function mockRequests(options: { recovery?: RecoveryView; unavailable?: boolean } = {}) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    if (path.startsWith("/api/courses/lookup?")) return Response.json({ courses: [] });
    if (path === "/api/courses/recovery") return options.unavailable
      ? Response.json({ error: "Sensitive infrastructure detail" }, { status: 503 })
      : Response.json({ recovery: options.recovery ?? queued }, { status: 201 });
    if (path.endsWith("/demand")) {
      if (init?.method === "POST") return Response.json({ demand: { id: "demand", status: "WAITING", teeSearchId: null } });
      if (init?.method === "DELETE") return Response.json({ demand: { id: "demand", status: "CANCELLED", teeSearchId: null } });
      return Response.json({ demand: null });
    }
    if (path.startsWith("/api/courses/recovery/")) return Response.json({ recovery: options.recovery ?? queued });
    if (path === "/api/feedback") return Response.json({ feedback: { id: "feedback" } }, { status: 201 });
    if (path === "/api/analytics/events") return Response.json({ event: { id: "event" } }, { status: 201 });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  return fetchMock;
}

function findMissingCourse(name = "Salt Marsh Public Links") {
  fireEvent.change(screen.getByLabelText("Course name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Find course" }));
}

describe("missing course recovery intake", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearSearchDraft();
    window.sessionStorage.clear();
  });

  it("requires explicit town when the visitor uses current location", async () => {
    const fetchMock = mockRequests();
    render(<TeeTimeIntake {...account} initialValues={{ ...initialValues, location: "Current location" }} />);
    findMissingCourse();
    await screen.findByText("Enter the course's town or city so we can verify the right course.");
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/courses/"))).toBe(false);
    fireEvent.change(screen.getByLabelText("Course town or city"), { target: { value: "Seabrook, NH" } });
    fireEvent.click(screen.getByRole("button", { name: "Find course" }));
    await screen.findByText(queued.message);
    const request = fetchMock.mock.calls.find(([url]) => url === "/api/courses/recovery");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ name: verifiedCourse.name, town: "Seabrook, NH" });
  });

  it("retains a bounded investigation separately from account-owned pending alert settings", async () => {
    const fetchMock = mockRequests();
    render(<TeeTimeIntake {...account} initialValues={initialValues} />);
    findMissingCourse();
    await screen.findByText(queued.message);
    await waitFor(() => expect((screen.getByRole("button", { name: "Save alert request for this course" }) as HTMLButtonElement).disabled).toBe(false));
    const receipt = JSON.parse(window.sessionStorage.getItem(COURSE_RECOVERY_RECEIPT_KEY)!);
    expect(receipt).toEqual({ id: queued.id, input: { name: verifiedCourse.name, town: "Seabrook, NH" } });
    expect(JSON.stringify(receipt)).not.toContain("owner@example.com");
    fireEvent.change(screen.getByRole("textbox", { name: "Additional recipient 1" }), { target: { value: "Friend@Example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save alert request for this course" }));
    await screen.findByRole("button", { name: "Cancel saved alert request" });
    expect(screen.getByText(/Saved requests stay active when you browse or correct another course/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage saved course requests on your dashboard" }).getAttribute("href")).toBe("/dashboard");
    const saved = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/demand") && init?.method === "POST");
    expect(JSON.parse(String(saved?.[1]?.body))).toEqual({ settings: expect.objectContaining({
      date: initialValues.date, startTime: "09:00", endTime: "12:00", players: 2,
      additionalEmails: ["friend@example.com"], cadenceMinutes: 5
    }) });
    expect(String(saved?.[1]?.body)).not.toContain("alertEmail");
    expect(String(saved?.[1]?.body)).not.toContain("owner@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Cancel saved alert request" }));
    await screen.findByText("Your saved alert request was cancelled.");
  });

  it("does not claim a durable investigation when recovery is unavailable", async () => {
    const fetchMock = mockRequests({ unavailable: true });
    render(<TeeTimeIntake {...account} initialValues={initialValues} />);
    findMissingCourse();
    await screen.findByText("We couldn't save a course investigation right now. Try Find course again in a moment.");
    expect(screen.queryByText(queued.message)).toBeNull();
    expect(screen.queryByText("Sensitive infrastructure detail")).toBeNull();
    expect(window.sessionStorage.getItem(COURSE_RECOVERY_RECEIPT_KEY)).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/demand"))).toBe(false);
  });

  it("reuses a receipt after repeat lookup and restores a verified selectable result without changing ranks", async () => {
    const first = { ...verifiedCourse, name: "Existing Choice", googlePlaceId: "existing-choice" };
    window.sessionStorage.setItem(SEARCH_DRAFT_STORAGE_KEY, JSON.stringify({ date: initialValues.date, courses: [first], selectedCourses: [first] }));
    const fetchMock = mockRequests();
    const mounted = render(<TeeTimeIntake {...account} initialValues={initialValues} />);
    await screen.findAllByRole("heading", { name: "Existing Choice" });
    findMissingCourse();
    await screen.findByText(queued.message);
    findMissingCourse();
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === "/api/courses/recovery")).toHaveLength(2));
    await screen.findByText(queued.message);
    expect(JSON.parse(window.sessionStorage.getItem(COURSE_RECOVERY_RECEIPT_KEY)!).id).toBe(queued.id);
    mounted.unmount();
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => String(input) === `/api/courses/recovery/${queued.id}`
      ? Response.json({ recovery: { ...queued, status: "VERIFIED", course: verifiedCourse, message: "This public course is verified." } })
      : fallback(input, init));
    render(<TeeTimeIntake {...account} initialValues={initialValues} />);
    await screen.findByRole("heading", { name: verifiedCourse.name });
    expect(document.querySelectorAll(".selected-list .selected-row")).toHaveLength(1);
    expect(screen.getByRole("button", { name: `Add ${verifiedCourse.name}` })).toBeTruthy();
    expect(document.querySelector(".selected-list")?.textContent).toContain("Existing Choice");
    fireEvent.click(screen.getByRole("button", { name: `Add ${verifiedCourse.name}` }));
    await waitFor(() => expect(document.querySelectorAll(".selected-list .selected-row")).toHaveLength(2));
    const draft = JSON.parse(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)!);
    expect(draft.selectedCourses.map((course: { googlePlaceId: string }) => course.googlePlaceId)).toEqual([first.googlePlaceId, verifiedCourse.googlePlaceId]);
  });

  it("asks the precise ambiguity question and lets the visitor correct name and town", async () => {
    mockRequests({ recovery: { ...queued, status: "NEEDS_DETAILS", message: "More than one facility matches.",
      question: "Do you mean Salt Marsh Links in Seabrook, NH or Seabrook, SC?" } });
    render(<TeeTimeIntake {...account} initialValues={initialValues} />);
    findMissingCourse();
    await screen.findByText("Do you mean Salt Marsh Links in Seabrook, NH or Seabrook, SC?");
    expect(screen.queryByRole("button", { name: "Save alert request for this course" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Update course details" }));
    expect((screen.getByLabelText("Course name") as HTMLInputElement).value).toBe(verifiedCourse.name);
    expect((screen.getByLabelText("Course town or city") as HTMLInputElement).value).toBe("Seabrook, NH");
    expect(document.activeElement).toBe(screen.getByLabelText("Course name"));
    expect(screen.getByLabelText("Street address (optional)")).toBeTruthy();
    expect(screen.getByLabelText("Official website (optional)")).toBeTruthy();
  });

  it("keeps unresolved evidence distinct from nonexistence", async () => {
    mockRequests({ recovery: { ...queued, status: "UNRESOLVED", message: "We couldn't establish the course's identity yet." } });
    render(<TeeTimeIntake {...account} initialValues={initialValues} />);
    findMissingCourse("Fictional Moonlight Links");
    await screen.findByText(/A missing result doesn't mean the course doesn't exist/);
    expect(screen.queryByRole("button", { name: "Save alert request for this course" })).toBeNull();
    expect(document.querySelectorAll(".selected-list .selected-row")).toHaveLength(0);
  });

  it("shows the precise technical-access question and keeps private URLs out of investigation requests", async () => {
    const fetchMock = mockRequests({ recovery: { ...queued, status: "ACCESS_LIMITED",
      message: "The official site requires a sign-in we can't use.",
      question: "Is there a public official course website that does not require a sign-in?",
      officialSiteUrl: verifiedCourse.website } });
    render(<TeeTimeIntake {...account} initialValues={initialValues} />);
    findMissingCourse();
    await screen.findByText("Is there a public official course website that does not require a sign-in?");
    expect(screen.getByRole("link", { name: "Official site", exact: true }).getAttribute("href")).toBe(verifiedCourse.website);
    fireEvent.click(screen.getByRole("button", { name: "Update course details" }));
    fireEvent.change(screen.getByLabelText("Official website (optional)"), { target: { value: "https://example.com/course?token=private" } });
    fireEvent.click(screen.getByRole("button", { name: "Find course" }));
    await screen.findByText("Use the course's public website without account credentials or private links.");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/courses/recovery")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body).includes("token=private"))).toBe(false);
  });

  it("shows the server's removed-alert outcome when an activated request no longer has an alert", async () => {
    const fetchMock = mockRequests();
    const fallback = fetchMock.getMockImplementation()!;
    const message = "The alert created from this request was removed. Choose this course to start a new alert.";
    fetchMock.mockImplementation(async (input, init) => String(input).endsWith("/demand")
      ? Response.json({ demand: { id: "demand", status: "ACTIVATED", teeSearchId: null, message } })
      : fallback(input, init));
    render(<TeeTimeIntake {...account} initialValues={initialValues} />);
    findMissingCourse();
    await screen.findByText(message);
    expect(screen.queryByRole("button", { name: "Save alert request for this course" })).toBeNull();
  });

  it("restores bounded identity hints without persisting recipient authority", async () => {
    window.sessionStorage.setItem(COURSE_RECOVERY_RECEIPT_KEY, JSON.stringify({ id: queued.id,
      input: { name: verifiedCourse.name, town: "Seabrook, NH", address: "10 Marsh Rd", officialWebsite: verifiedCourse.website,
        alertEmail: "tampered@example.com" } }));
    mockRequests({ recovery: { ...queued, status: "NEEDS_DETAILS", message: "Please confirm the course address.", question: "Which street is the course on?" } });
    render(<TeeTimeIntake {...account} initialValues={initialValues} />);
    await screen.findByText("Which street is the course on?");
    fireEvent.click(screen.getByRole("button", { name: "Update course details" }));
    expect((screen.getByLabelText("Street address (optional)") as HTMLInputElement).value).toBe("10 Marsh Rd");
    expect((screen.getByLabelText("Official website (optional)") as HTMLInputElement).value).toBe(verifiedCourse.website);
    expect(document.querySelector(".course-recovery-panel")?.textContent).not.toContain("tampered@example.com");
  });

  it("does not restore an older receipt over a newly submitted request", async () => {
    window.sessionStorage.setItem(COURSE_RECOVERY_RECEIPT_KEY, JSON.stringify({ id: "older-request", input: { name: "Older course", town: "Other town" } }));
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
    const fetchMock = mockRequests();
    render(<TeeTimeIntake {...account} initialValues={initialValues} />);
    findMissingCourse();
    await screen.findByText(queued.message);
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0);
    });
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/courses/recovery/older-request")).toBe(false);
    expect(JSON.parse(window.sessionStorage.getItem(COURSE_RECOVERY_RECEIPT_KEY)!).id).toBe(queued.id);
  });

  it("allows signed-out investigation without creating, reading or sending pending demand", async () => {
    const fetchMock = mockRequests();
    render(<TeeTimeIntake accountEnabled initialValues={initialValues} />);
    findMissingCourse();
    await screen.findByText(queued.message);
    expect(screen.getByText("Sign in to save an alert request. The course investigation can continue without an account.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save alert request for this course" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/demand") || url === "/api/searches")).toBe(false);
    const requests = fetchMock.mock.calls.filter(([url]) => url === "/api/courses/recovery");
    expect(requests).toHaveLength(1);
    expect(String(requests[0][1]?.body)).not.toContain("Email");
  });

  it.each(["CANCELLED", "EXPIRED", "ACTION_REQUIRED"] as const)(
    "does not offer to reopen a terminal %s pending alert request", async (status) => {
      const fetchMock = mockRequests();
      const fallback = fetchMock.getMockImplementation()!;
      fetchMock.mockImplementation(async (input, init) => String(input).endsWith("/demand")
        ? Response.json({ demand: { id: "terminal-demand", status, teeSearchId: null,
          message: "The saved request requires a new alert after verification." } })
        : fallback(input, init));
      render(<TeeTimeIntake {...account} initialValues={initialValues} />);
      findMissingCourse();
      await screen.findByText("This saved request will not restart. Once the course is verified, select it from Direct search to create a new alert with a future date.");
      expect(screen.queryByRole("button", { name: "Save alert request for this course" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Cancel saved alert request" })).toBeNull();
      expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith("/demand") && init?.method === "POST")).toBe(false);
    }
  );
});
