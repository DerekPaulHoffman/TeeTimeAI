import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchStatusActions } from "./search-status-actions";

const refreshMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: refreshMock
  })
}));

describe("SearchStatusActions", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    refreshMock.mockReset();
  });

  it("saves reordered course priorities from the dashboard edit form", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SearchStatusActions
        searchId="search-1"
        status="ACTIVE"
        initialDate="2026-08-15"
        initialStartTime="13:00"
        initialEndTime="17:00"
        initialUserTimeZone="America/New_York"
        initialPlayers={2}
        initialRequestedLayoutHoles={18}
        initialCadenceMinutes={15}
        initialAdditionalEmails={[]}
        initialCheckStatus="WAITING"
        initialLastCheckedAt="2026-08-14T12:00:00.000Z"
        initialNextCheckAt="2026-08-14T12:15:00.000Z"
        initialCoursePreferences={[
          { id: "pref-a", courseName: "Longshore Golf Course", rank: 1 },
          { id: "pref-b", courseName: "Tashua Knolls Golf Course", rank: 2 }
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    expect(screen.getByText("Course priority")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Move Tashua Knolls Golf Course up" })
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(requestInit.body as string).coursePreferences).toEqual([
      { id: "pref-b", rank: 1 },
      { id: "pref-a", rank: 2 }
    ]);
    expect(JSON.parse(requestInit.body as string).requestedLayoutHoles).toBe(18);
  });

  it("saves course priorities reordered by dragging rows", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SearchStatusActions
        searchId="search-1"
        status="ACTIVE"
        initialDate="2026-08-15"
        initialStartTime="13:00"
        initialEndTime="17:00"
        initialUserTimeZone="America/New_York"
        initialPlayers={2}
        initialRequestedLayoutHoles={null}
        initialCadenceMinutes={15}
        initialAdditionalEmails={[]}
        initialCheckStatus="WAITING"
        initialLastCheckedAt="2026-08-14T12:00:00.000Z"
        initialNextCheckAt="2026-08-14T12:15:00.000Z"
        initialCoursePreferences={[
          { id: "pref-a", courseName: "Longshore Golf Course", rank: 1 },
          { id: "pref-b", courseName: "Tashua Knolls Golf Course", rank: 2 },
          { id: "pref-c", courseName: "Oak Hills Park Golf Course", rank: 3 }
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    let draggedPreferenceId = "";
    const dataTransfer = {
      dropEffect: "move",
      effectAllowed: "move",
      getData: vi.fn(() => draggedPreferenceId),
      setData: vi.fn((_type: string, value: string) => {
        draggedPreferenceId = value;
      })
    };

    fireEvent.dragStart(screen.getByRole("listitem", { name: /Longshore Golf Course/i }), {
      dataTransfer
    });
    fireEvent.dragOver(screen.getByRole("listitem", { name: /Oak Hills Park Golf Course/i }), {
      dataTransfer
    });
    fireEvent.drop(screen.getByRole("listitem", { name: /Oak Hills Park Golf Course/i }), {
      dataTransfer
    });

    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(requestInit.body as string).coursePreferences).toEqual([
      { id: "pref-b", rank: 1 },
      { id: "pref-c", rank: 2 },
      { id: "pref-a", rank: 3 }
    ]);
  });

  it("queues an immediate availability check", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <SearchStatusActions
        searchId="search-1"
        status="ACTIVE"
        initialDate="2026-08-15"
        initialStartTime="13:00"
        initialEndTime="17:00"
        initialUserTimeZone="America/New_York"
        initialPlayers={2}
        initialRequestedLayoutHoles={null}
        initialCadenceMinutes={15}
        initialAdditionalEmails={[]}
        initialCheckStatus="WAITING"
        initialLastCheckedAt="2026-08-14T12:00:00.000Z"
        initialNextCheckAt="2026-08-14T12:15:00.000Z"
        initialCoursePreferences={[
          { id: "pref-a", courseName: "Longshore Golf Course", rank: 1 }
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /check now/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/searches/search-1/check", {
        method: "POST"
      })
    );
    expect(screen.getByText("Checking")).toBeTruthy();
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(/we’re working on getting your tee times/i)).toBeTruthy();
    expect(screen.getByText(/update automatically when we finish/i)).toBeTruthy();
  });

  it("shows when tee times were updated and when the next check will run", () => {
    render(
      <SearchStatusActions
        searchId="search-1"
        status="ACTIVE"
        initialDate="2026-08-15"
        initialStartTime="13:00"
        initialEndTime="17:00"
        initialUserTimeZone="America/New_York"
        initialPlayers={2}
        initialRequestedLayoutHoles={null}
        initialCadenceMinutes={15}
        initialAdditionalEmails={[]}
        initialCheckStatus="WAITING"
        initialLastCheckedAt="2026-08-14T12:00:00.000Z"
        initialNextCheckAt="2026-08-14T12:15:00.000Z"
        initialCoursePreferences={[
          { id: "pref-a", courseName: "Longshore Golf Course", rank: 1 }
        ]}
      />
    );

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(/tee times updated/i)).toBeTruthy();
    expect(screen.getByText(/last checked fri, aug 14, 8:00 am edt/i)).toBeTruthy();
    expect(screen.getByText(/next check: fri, aug 14, 8:15 am edt/i)).toBeTruthy();
  });

  it("keeps refreshing the dashboard while a check is in progress", () => {
    vi.useFakeTimers();

    render(
      <SearchStatusActions
        searchId="search-1"
        status="ACTIVE"
        initialDate="2026-08-15"
        initialStartTime="13:00"
        initialEndTime="17:00"
        initialUserTimeZone="America/New_York"
        initialPlayers={2}
        initialRequestedLayoutHoles={null}
        initialCadenceMinutes={15}
        initialAdditionalEmails={[]}
        initialCheckStatus="CHECKING"
        initialLastCheckedAt={null}
        initialNextCheckAt={null}
        initialCoursePreferences={[
          { id: "pref-a", courseName: "Longshore Golf Course", rank: 1 }
        ]}
      />
    );

    act(() => vi.advanceTimersByTime(5100));

    expect(refreshMock).toHaveBeenCalledTimes(2);
  });
});
