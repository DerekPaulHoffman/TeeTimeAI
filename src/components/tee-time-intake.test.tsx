import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearSearchDraft,
  SEARCH_DRAFT_STORAGE_KEY
} from "@/lib/searches/search-draft";

import { TeeTimeIntake } from "./tee-time-intake";

const pushMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock })
}));

vi.mock("@clerk/nextjs", () => ({
  SignInButton: ({ children }: { children: ReactNode }) => children,
  useUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: {
      primaryEmailAddress: { emailAddress: "golfer@example.com" }
    }
  })
}));

describe("TeeTimeIntake", () => {
  afterEach(() => {
    pushMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSearchDraft();
    window.sessionStorage.clear();
    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("opens My Alerts after saving a new alert", async () => {
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
        accountEnabled
        initialValues={{ location: "Trumbull, CT" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("heading", { name: "Test Public Golf Course" });
    fireEvent.click(screen.getByRole("button", { name: "Add Test Public Golf Course" }));
    await waitFor(() =>
      expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).toContain("course-1")
    );
    fireEvent.click(screen.getByRole("button", { name: "Start getting alerts" }));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/dashboard?created=search-123")
    );
    expect(window.sessionStorage.getItem(SEARCH_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("restores discovered courses and their ranking after the search page remounts", async () => {
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
      <TeeTimeIntake accountEnabled initialValues={{ location: "Trumbull, CT" }} />
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
    fetchMock.mockClear();
    render(<TeeTimeIntake accountEnabled />);

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
    expect(fetchMock).not.toHaveBeenCalled();
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

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));

    render(
      <TeeTimeIntake
        accountEnabled
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
    expect(screen.getByText("Possible course")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add Wheeler Family Traditions Golf Club"
      })
    );

    await screen.findByText(
      "Wheeler Family Traditions Golf Club was added to your list and saved for public-course review. Alerts can start after it is verified."
    );
    expect(screen.getByText("Public access verification needed")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start getting alerts" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(
      screen.getByText(
        "Wheeler Family Traditions Golf Club still needs public-course verification. It is saved to your list, but alerts cannot start for it yet."
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
  });
});
