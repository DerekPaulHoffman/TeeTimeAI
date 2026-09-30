import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearSearchDraft,
  SEARCH_DRAFT_STORAGE_KEY
} from "@/lib/searches/search-draft";
import {
  WEBSITE_SYNTHETIC_MULTI_CYCLE_HEADER,
  WEBSITE_SYNTHETIC_MULTI_CYCLE_STORAGE_KEY,
  WEBSITE_TRAFFIC_CLASS_HEADER,
  WEBSITE_TRAFFIC_CLASS_STORAGE_KEY
} from "@/lib/engagement/traffic-class";
import { OPEN_FEEDBACK_EVENT } from "@/components/open-feedback-button";

import { TeeTimeIntake } from "./tee-time-intake";

const pushMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock })
}));

const signedInAccountProps = {
  accountEmail: "golfer@example.com",
  accountEnabled: true,
  accountSignedIn: true
} as const;

function dateBoundaryCourse(name: string, timeZone: string) {
  return {
    address: "100 Public Links Rd",
    googlePlaceId: `date-${name}`,
    latitude: 41.24,
    longitude: -73.2,
    monitoringSupport: "AUTOMATIC",
    name,
    timeZone,
    website: "https://example.com/course"
  };
}

function restoreDateBoundaryDraft(
  courses: ReturnType<typeof dateBoundaryCourse>[],
  selectedCourses: ReturnType<typeof dateBoundaryCourse>[],
  date = "2026-09-30"
) {
  window.sessionStorage.setItem(SEARCH_DRAFT_STORAGE_KEY, JSON.stringify({
    date,
    courses,
    selectedCourses
  }));
}

function mockDateBoundaryRequests() {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url === "/api/searches") {
      return Response.json({ search: { id: "date-boundary" } }, { status: 201 });
    }
    if (url === "/api/analytics/events") {
      return Response.json({ event: { id: "event-1" } }, { status: 201 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
  return fetchMock;
}

describe("TeeTimeIntake", () => {
  afterEach(() => {
    document.querySelectorAll("[data-alert-confetti]").forEach((element) => element.remove());
    pushMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearSearchDraft();
    window.sessionStorage.clear();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("restores and saves tomorrow in the selected course's calendar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T03:16:30.000Z"));
    const course = dateBoundaryCourse("New York Course", "America/New_York");
    restoreDateBoundaryDraft([course], [course]);
    const fetchMock = mockDateBoundaryRequests();
    render(<TeeTimeIntake {...signedInAccountProps} />);
    await screen.findAllByRole("heading", { name: "New York Course" });
    const dateInput = document.querySelector("#date") as HTMLInputElement;
    await waitFor(() => expect(dateInput.min).toBe(
      "2026-09-30"
    ));
    expect(dateInput.value).toBe("2026-09-30");
    fireEvent.click(screen.getByRole("button", { name: "Start getting alerts" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard?created=date-boundary"));
    const save = fetchMock.mock.calls.find(([input]) => input === "/api/searches");
    const payload = JSON.parse(String(save?.[1]?.body)) as Record<string, unknown>;
    expect(payload.date).toBe("2026-09-30");
    expect(payload.courses).toEqual([expect.objectContaining({ timeZone: "America/New_York" })]);
  });

  it("recomputes the date floor when courses change while preserving an edited date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T03:16:30.000Z"));
    const newYork = dateBoundaryCourse("New York Course", "America/New_York");
    const tokyo = dateBoundaryCourse("Tokyo Course", "Asia/Tokyo");
    restoreDateBoundaryDraft([newYork, tokyo], [newYork]);
    mockDateBoundaryRequests();
    render(<TeeTimeIntake {...signedInAccountProps} />);
    await screen.findAllByRole("heading", { name: "New York Course" });
    const dateInput = document.querySelector("#date") as HTMLInputElement;
    await waitFor(() => expect(dateInput.min).toBe("2026-09-30"));
    fireEvent.change(dateInput, { target: { value: "2026-09-30" } });
    fireEvent.blur(dateInput);
    fireEvent.click(screen.getByRole("button", { name: "Add Tokyo Course" }));

    await waitFor(() => expect(dateInput.min).toBe("2026-10-01"));
    expect(dateInput.value).toBe("2026-09-30");
    expect((screen.getByRole("button", { name: "Start getting alerts" }) as HTMLButtonElement)
      .disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Remove Tokyo Course" })[0]);
    await waitFor(() => expect(dateInput.min).toBe("2026-09-30"));
    expect(dateInput.value).toBe("2026-09-30");
    expect((screen.getByRole("button", { name: "Start getting alerts" }) as HTMLButtonElement)
      .disabled).toBe(false);
  });

  it("advances an untouched date at course midnight when the tab regains focus", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T03:16:30.000Z"));
    const course = dateBoundaryCourse("New York Course", "America/New_York");
    restoreDateBoundaryDraft([course], [course]);
    mockDateBoundaryRequests();
    render(<TeeTimeIntake {...signedInAccountProps} />);
    await screen.findAllByRole("heading", { name: "New York Course" });
    const dateInput = document.querySelector("#date") as HTMLInputElement;
    await waitFor(() => expect(dateInput.min).toBe("2026-09-30"));
    vi.setSystemTime(new Date("2026-09-30T04:00:01.000Z"));
    fireEvent.focus(window);
    await waitFor(() => expect(dateInput.min).toBe("2026-10-01"));
    expect(dateInput.value).toBe("2026-10-03");
  });

  it("advances an untouched automatic date without posting when a delayed timer leaves it stale at save", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T03:59:00.000Z"));
    const course = dateBoundaryCourse("New York Course", "America/New_York");
    restoreDateBoundaryDraft([course], [course], "2026-09-26");
    const fetchMock = mockDateBoundaryRequests();
    render(<TeeTimeIntake {...signedInAccountProps} />);
    await screen.findAllByRole("heading", { name: "New York Course" });
    const dateInput = document.querySelector("#date") as HTMLInputElement;
    await waitFor(() => expect(dateInput.min).toBe("2026-09-26"));
    expect(dateInput.value).toBe("2026-09-26");

    vi.setSystemTime(new Date("2026-09-26T04:00:01.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Start getting alerts" }));
    await waitFor(() => expect(dateInput.min).toBe("2026-09-27"));
    expect(dateInput.value).toBe("2026-10-03");
    expect(fetchMock.mock.calls.some(([input]) => input === "/api/searches")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Start getting alerts" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/dashboard?created=date-boundary"));
    const saves = fetchMock.mock.calls.filter(([input]) => input === "/api/searches");
    expect(saves).toHaveLength(1);
    expect(JSON.parse(String(saves[0][1]?.body)).date).toBe("2026-10-03");
  });

  it("preserves an edited date and blocks saving after course midnight when a timer is delayed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T03:16:30.000Z"));
    const course = dateBoundaryCourse("New York Course", "America/New_York");
    restoreDateBoundaryDraft([course], [course]);
    const fetchMock = mockDateBoundaryRequests();
    render(<TeeTimeIntake {...signedInAccountProps} />);
    await screen.findAllByRole("heading", { name: "New York Course" });
    const dateInput = document.querySelector("#date") as HTMLInputElement;
    await waitFor(() => expect(dateInput.min).toBe("2026-09-30"));
    fireEvent.change(dateInput, { target: { value: "2026-09-30" } });
    fireEvent.blur(dateInput);
    vi.setSystemTime(new Date("2026-09-30T04:00:01.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Start getting alerts" }));
    await waitFor(() => expect(dateInput.min).toBe("2026-10-01"));
    expect(dateInput.value).toBe("2026-09-30");
    expect(fetchMock.mock.calls.some(([input]) => input === "/api/searches")).toBe(false);
  });

  it("opens My Alerts after saving a new alert", async () => {
    window.sessionStorage.setItem(WEBSITE_TRAFFIC_CLASS_STORAGE_KEY, "TEST");
    window.sessionStorage.setItem(
      WEBSITE_SYNTHETIC_MULTI_CYCLE_STORAGE_KEY,
      "true"
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith("/api/location/geocode")) {
        return Response.json({ latitude: 41.24, longitude: -73.2 });
      }

      if (url.startsWith("/api/courses/discover")) {
        return Response.json({
          courses: [
            {
              address: "100 Public Links Rd, Trumbull, CT",
              googlePlaceId: "course-1",
              latitude: 41.24,
              longitude: -73.2,
              monitoringSupport: "AUTOMATIC",
              name: "Test Public Golf Course",
              timeZone: "America/New_York",
              website: "https://example.com/course-1"
            }
          ]
        });
      }

      if (url === "/api/searches") {
        return Response.json({ search: { id: "search-123" } }, { status: 201 });
      }

      if (url === "/api/analytics/events") {
        return Response.json({ event: { id: "event-1" } }, { status: 201 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <TeeTimeIntake
        {...signedInAccountProps}
        initialValues={{ location: "Trumbull, CT" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("heading", { name: "Test Public Golf Course" });
    fireEvent.click(screen.getByRole("button", { name: "Add Test Public Golf Course" }));
    await waitFor(() =>
      expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).toContain("course-1")
    );
    const alertEmail = screen.getByLabelText(/Primary alert email/);
    expect((alertEmail as HTMLInputElement).value).toBe("golfer@example.com");
    expect((alertEmail as HTMLInputElement).readOnly).toBe(true);
    fireEvent.change(alertEmail, { target: { value: "alternate@example.com" } });
    expect(screen.getByRole("group", { name: "Alert your group too" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start getting alerts" }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/dashboard?created=search-123")
    );
    expect(document.querySelector('[data-alert-confetti="alert-created"]')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/searches",
      expect.objectContaining({
        body: expect.stringContaining('"alertEmail":"golfer@example.com"')
      })
    );
    expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).toBeNull();
    const searchCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === "/api/searches"
    );
    expect(searchCall?.[1]?.headers).toMatchObject({
      [WEBSITE_TRAFFIC_CLASS_HEADER]: "TEST",
      [WEBSITE_SYNTHETIC_MULTI_CYCLE_HEADER]: "true"
    });
  });

  it("reconciles browser date and time values before previewing and saving the alert", async () => {
    const course = {
      address: "100 Public Links Rd, Trumbull, CT",
      googlePlaceId: "course-1",
      latitude: 41.24,
      longitude: -73.2,
      monitoringSupport: "AUTOMATIC",
      name: "Test Public Golf Course",
      timeZone: "America/New_York",
      website: "https://example.com/course-1"
    };
    window.sessionStorage.setItem(
      SEARCH_DRAFT_STORAGE_KEY,
      JSON.stringify({
        date: "2099-01-01",
        courses: [course],
        selectedCourses: [course]
      })
    );

    let savedPayload: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url === "/api/searches") {
        savedPayload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ search: { id: "search-input-sync" } }, { status: 201 });
      }

      if (url === "/api/analytics/events") {
        return Response.json({ event: { id: "event-1" } }, { status: 201 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));

    render(<TeeTimeIntake {...signedInAccountProps} />);

    await waitFor(() =>
      expect(document.querySelector(".figma-alert-preview")?.textContent).toContain(
        "Thursday, January 1"
      )
    );
    const dateInput = document.querySelector("#date") as HTMLInputElement;
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    nativeValueSetter?.call(dateInput, "2099-12-31");
    expect(dateInput.value).toBe("2099-12-31");

    fireEvent.blur(dateInput);

    await waitFor(() =>
      expect(document.querySelector(".figma-alert-preview")?.textContent).toContain(
        "Thursday, December 31"
      )
    );

    const startTimeInput = document.querySelector("#startTime") as HTMLInputElement;
    const endTimeInput = document.querySelector("#endTime") as HTMLInputElement;
    nativeValueSetter?.call(startTimeInput, "11:00");
    expect(startTimeInput.value).toBe("11:00");
    fireEvent.blur(startTimeInput);
    nativeValueSetter?.call(endTimeInput, "14:00");
    expect(endTimeInput.value).toBe("14:00");
    fireEvent.blur(endTimeInput);

    await waitFor(() =>
      expect(document.querySelector(".figma-alert-preview")?.textContent).toContain(
        "11 AM – 2 PM"
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Start getting alerts" }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/dashboard?created=search-input-sync")
    );
    expect(savedPayload).toEqual(
      expect.objectContaining({
        date: "2099-12-31",
        startTime: "11:00",
        endTime: "14:00"
      })
    );
  });

  it("restores discovered courses and their ranking after the search page remounts", async () => {
    let maximumPriceCents = 50000;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith("/api/location/geocode")) {
        return Response.json({ latitude: 41.24, longitude: -73.2 });
      }

      if (url.startsWith("/api/courses/discover")) {
        return Response.json({
          courses: [
            {
              address: "100 Public Links Rd, Trumbull, CT",
              googlePlaceId: "course-1",
              latitude: 41.24,
              longitude: -73.2,
              monitoringSupport: "AUTOMATIC",
              name: "Test Public Golf Course",
              priceEstimate: {
                currency: "USD",
                observedAt: "2026-07-21T18:07:53.000Z",
                nineHoles: {
                  minPriceCents: 3900,
                  maxPriceCents: maximumPriceCents,
                  sampleSize: 10
                }
              },
              layoutHoleCounts: [9],
              timeZone: "America/New_York",
              website: "https://example.com/course-1"
            },
            {
              address: "200 Second Links Rd, Trumbull, CT",
              googlePlaceId: "course-2",
              latitude: 41.25,
              longitude: -73.21,
              monitoringSupport: "AUTOMATIC",
              name: "Second Public Golf Course",
              timeZone: "America/New_York",
              website: "https://example.com/course-2"
            }
          ]
        });
      }

      if (url === "/api/analytics/events") {
        return Response.json({ event: { id: "event-1" } }, { status: 201 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn()
    });

    const firstRender = render(
      <TeeTimeIntake
        {...signedInAccountProps}
        initialValues={{ location: "Trumbull, CT" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("heading", { name: "Test Public Golf Course" });
    fireEvent.click(screen.getByRole("button", { name: "Add Test Public Golf Course" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Second Public Golf Course" }));
    fireEvent.click(screen.getByRole("button", { name: "Move Second Public Golf Course up" }));

    await waitFor(() => {
      const stored = window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY);
      expect(stored).not.toBeNull();
      const draft = JSON.parse(stored ?? "{}") as {
        selectedCourses?: Array<{ googlePlaceId?: string }>;
      };
      expect(draft.selectedCourses?.map((course) => course.googlePlaceId)).toEqual([
        "course-2",
        "course-1"
      ]);
    });

    firstRender.unmount();
    maximumPriceCents = 4300;
    fetchMock.mockClear();
    render(<TeeTimeIntake {...signedInAccountProps} />);

    expect(
      await screen.findAllByRole("heading", { name: "Second Public Golf Course" })
    ).not.toHaveLength(0);
    expect(
      screen.getAllByRole("button", { name: "Remove Second Public Golf Course" })
    ).not.toHaveLength(0);
    expect(
      (
        screen.getByRole("button", {
          name: "Move Second Public Golf Course up"
        }) as HTMLButtonElement
    ).disabled
    ).toBe(true);
    expect((screen.getByLabelText("Location") as HTMLInputElement).value).toBe("Trumbull, CT");
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/courses/discover?"),
        { cache: "no-store" }
      )
    );
    expect(await screen.findAllByText(/\$39.*\$43/)).not.toHaveLength(0);
    expect(screen.queryByText(/\$39.*\$500/)).toBeNull();
  });

  it("keeps a possible direct-lookup course in the list while public access is reviewed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith("/api/courses/lookup")) {
        return Response.json({
          courses: [
            {
              address: "37 Harrison Rd, Wallingford, CT 06492",
              googlePlaceId: "ChIJ99HILg3O54kRiJLIRU3WbfE",
              latitude: 41.4262453,
              longitude: -72.8153967,
              name: "Wheeler Family Traditions Golf Club",
              publicAccessStatus: "UNVERIFIED",
              timeZone: "America/New_York",
              website: "https://wheelertraditions.com/"
            }
          ]
        });
      }

      if (url === "/api/feedback") {
        return Response.json({ feedback: { id: "feedback-1" } }, { status: 201 });
      }

      if (url === "/api/analytics/events") {
        return Response.json({ event: { id: "event-1" } }, { status: 201 });
      }

      if (url === "/api/searches") {
        return Response.json(
          { search: { id: "pending-course-search" }, schedule: null },
          { status: 201 }
        );
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));

    render(
      <TeeTimeIntake
        {...signedInAccountProps}
        initialValues={{ location: "Wallingford, CT" }}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Looking for a specific course?" })
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Course name and town"), {
      target: { value: "wheeler family tranditions in wallinford" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Find course" }));

    await screen.findByRole("heading", {
      name: "Wheeler Family Traditions Golf Club"
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/courses/lookup?"),
      { cache: "no-store" }
    );
    expect(
      screen.getByText('Direct search · "wheeler family tranditions in wallinford"')
    ).toBeTruthy();
    expect(screen.getByRole("list", { name: "Direct course matches" })).toBeTruthy();
    expect(screen.getByText("Possible course")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Wheeler Family Traditions Golf Club"
      })
    );

    await screen.findByText(
      "Wheeler Family Traditions Golf Club was added to your list. Start the alert and we'll verify the course before checking for tee times."
    );
    expect(screen.getByText("Verify with this alert")).toBeTruthy();
    expect(screen.getByText("Verified after the alert starts")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start getting alerts" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
    expect(
      screen.getByText(
        "You’ll manage this alert from your signed-in account (golfer@example.com). Alerts go to that address and any extra recipients you add."
      )
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/feedback",
      expect.objectContaining({
        body: expect.stringContaining("[COURSE_LOOKUP_CANDIDATE]")
      })
    );
    await waitFor(() =>
      expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).toContain(
        '"publicAccessStatus":"UNVERIFIED"'
      )
    );

    fireEvent.click(screen.getByRole("button", { name: "Start getting alerts" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/searches",
        expect.objectContaining({
          body: expect.stringContaining('"publicAccessStatus":"UNVERIFIED"')
        })
      )
    );
  });

  it("shows actionable course-lookup validation copy", async () => {
    const validationMessage =
      "Enter a course name between 2 and 120 characters.";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith("/api/courses/lookup")) {
        return Response.json({ error: validationMessage }, { status: 400 });
      }

      if (url === "/api/analytics/events") {
        return Response.json({ event: { id: "event-1" } }, { status: 201 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));

    const { unmount } = render(
      <TeeTimeIntake
        {...signedInAccountProps}
        initialValues={{ location: "Wallingford, CT" }}
      />
    );

    fireEvent.change(screen.getByLabelText("Course name and town"), {
      target: { value: "Example public course" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Find course" }));

    expect(await screen.findByText(validationMessage)).toBeTruthy();
    unmount();
  });

  it("replaces Add with Report inaccuracy for a course that needs access review", async () => {
    const feedbackEvents: CustomEvent[] = [];
    const handleFeedback = (event: Event) => {
      feedbackEvents.push(event as CustomEvent);
    };
    window.addEventListener(OPEN_FEEDBACK_EVENT, handleFeedback);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.startsWith("/api/location/geocode")) {
        return Response.json({ latitude: 41.24, longitude: -73.2 });
      }

      if (url.startsWith("/api/courses/discover")) {
        return Response.json({
          courses: [
            {
              address: "1 Review Rd, Trumbull, CT",
              googlePlaceId: "course-review",
              latitude: 41.24,
              longitude: -73.2,
              monitoringSupport: "MANUAL_ONLY",
              name: "Review This Golf Course",
              publicAccessStatus: "REVIEW_REQUIRED",
              timeZone: "America/New_York"
            }
          ]
        });
      }

      if (url === "/api/analytics/events") {
        return Response.json({ event: { id: "event-1" } }, { status: 201 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn()
    });

    render(
      <TeeTimeIntake
        {...signedInAccountProps}
        initialValues={{ location: "Trumbull, CT" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("heading", { name: "Review This Golf Course" });

    expect(screen.queryByText("Needs review")).toBeNull();
    expect(
      screen.queryByText(
        "Our current information says this course may not be public."
      )
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Add Review This Golf Course" })
    ).toBeNull();
    expect(screen.getByText("Private or invalid course record")).toBeTruthy();
    expect(
      screen.getByText(
        "Current exact identity evidence shows that this is private, not a playable public course, or no longer a valid course record."
      )
    ).toBeTruthy();
    expect(
      screen.queryByText(/cannot check this course automatically yet/i)
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Report inaccuracy for Review This Golf Course"
      })
    );

    expect(feedbackEvents).toHaveLength(1);
    expect(feedbackEvents[0].detail).toMatchObject({
      sentiment: "broken",
      message: expect.stringContaining(
        "I think Review This Golf Course at 1 Review Rd, Trumbull, CT is a public golf course"
      )
    });

    window.removeEventListener(OPEN_FEEDBACK_EVENT, handleFeedback);
  });

  it("shows a styled recovery toast with feedback when alert creation fails", async () => {
    const course = {
      address: "100 Public Links Rd, Trumbull, CT",
      googlePlaceId: "course-1",
      latitude: 41.24,
      longitude: -73.2,
      monitoringSupport: "AUTOMATIC",
      name: "Test Public Golf Course",
      timeZone: "America/New_York"
    };
    window.sessionStorage.setItem(
      SEARCH_DRAFT_STORAGE_KEY,
      JSON.stringify({
        date: "2099-01-01",
        courses: [course],
        selectedCourses: [course]
      })
    );

    const feedbackEvents: CustomEvent[] = [];
    const handleFeedback = (event: Event) => {
      feedbackEvents.push(event as CustomEvent);
    };
    window.addEventListener(OPEN_FEEDBACK_EVENT, handleFeedback);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/searches") {
        return Response.json({ error: "Internal course classification mismatch" }, { status: 400 });
      }
      if (url === "/api/analytics/events") {
        return Response.json({ event: { id: "event-1" } }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));

    render(<TeeTimeIntake {...signedInAccountProps} />);

    const saveButton = screen.getByRole("button", { name: "Start getting alerts" });
    await waitFor(() =>
      expect((saveButton as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(saveButton);

    const toastTitle = await screen.findByText("We couldn't start your alert");
    expect(toastTitle.closest('[role="alert"]')?.textContent).toContain(
      "Something went wrong, and we're working on it."
    );
    expect(document.querySelector("[data-alert-confetti]")).toBeNull();
    expect(screen.queryByText("Internal course classification mismatch")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(feedbackEvents).toHaveLength(1);
    expect(feedbackEvents[0].detail).toMatchObject({
      sentiment: "broken",
      message: expect.stringContaining("Test Public Golf Course")
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss alert error" }));
    expect(screen.queryByText("We couldn't start your alert")).toBeNull();

    window.removeEventListener(OPEN_FEEDBACK_EVENT, handleFeedback);
  });

  it("shows actionable retry copy instead of upstream geocode details", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/location/geocode")) {
        return Response.json(
          { error: "Google Places text search failed with 429" },
          { status: 503 }
        );
      }
      if (url === "/api/analytics/events") {
        return Response.json({ event: { id: "event-1" } }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));

    render(
      <TeeTimeIntake
        {...signedInAccountProps}
        initialValues={{ location: "83702" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(
      await screen.findByText(
        "We couldn't search that location right now. Please wait a moment and try again."
      )
    ).toBeTruthy();
    expect(screen.queryByText(/Google Places|429/)).toBeNull();
    expect(screen.getByLabelText("Location").getAttribute("aria-invalid")).toBe("false");
  });
});
