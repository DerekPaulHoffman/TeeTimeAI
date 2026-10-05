import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchStatusActions } from "./search-status-actions";

const refreshMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: refreshMock
  })
}));

const savedSearch: ComponentProps<typeof SearchStatusActions> = {
  searchId: "search-1",
  status: "ACTIVE",
  initialDate: "2026-08-15",
  initialStartTime: "13:00",
  initialEndTime: "17:00",
  initialUserTimeZone: "America/New_York",
  initialPlayers: 2,
  initialRequestedLayoutHoles: null,
  initialCadenceMinutes: 15,
  initialAdditionalEmails: [],
  initialCheckStatus: "WAITING",
  initialScheduleVersion: 1,
  initialLastCheckedAt: "2026-08-14T12:00:00.000Z",
  initialNextCheckAt: "2026-08-14T12:15:00.000Z",
  initialCoursePreferences: [
    { id: "pref-a", courseName: "Longshore Golf Course", rank: 1 },
    { id: "pref-b", courseName: "Tashua Knolls Golf Course", rank: 2 }
  ]
};

describe("SearchStatusActions", () => {
  it("edits an individual notification without course ranking and retains its course", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<SearchStatusActions {...savedSearch} initialCoursePreferences={[savedSearch.initialCoursePreferences[0]]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByText("Course priority")).toBeNull();
    fireEvent.change(screen.getByLabelText("Players"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.players).toBe(3);
    expect(payload.coursePreferences).toEqual([{ id: "pref-a", rank: 1 }]);
  });

  it("edits a simulator alert with the ordinary player selector and preserves its recipients and ranked courses", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    render(<SearchStatusActions {...savedSearch} mode="SIMULATOR" initialAdditionalEmails={["friend@example.com"]} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const players = screen.getByLabelText("Players") as HTMLSelectElement;
    expect([...players.options].map(option => option.value)).toEqual(["1", "2", "3", "4"]);
    expect(screen.queryByLabelText("Session length")).toBeNull();
    expect(screen.queryByLabelText("Course layout")).toBeNull();
    fireEvent.change(players, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Move Tashua Knolls Golf Course up" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/searches/search-1", expect.objectContaining({ method: "PATCH" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      mode: "SIMULATOR",
      players: 4,
      durationMinutes: 60,
      requestedLayoutHoles: null,
      additionalEmails: ["friend@example.com"],
      coursePreferences: [{ id: "pref-b", rank: 1 }, { id: "pref-a", rank: 2 }]
    });
  });

  it("explains a past paused date and prevents starting it again", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SearchStatusActions {...savedSearch} status="PAUSED" windowEnded />);
    const resume = screen.getByRole("button", { name: "Resume notifications" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    expect(screen.getByText("This date has passed")).toBeTruthy();
    fireEvent.click(resume);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove alert" })).toBeTruthy();
  });

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
    expect(screen.getByText(/we’re checking for tee times/i)).toBeTruthy();
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

  it.each(["COMPLETED", "CANCELLED"] as const)(
    "replaces paused controls when the saved alert becomes %s",
    (status) => {
      const { rerender } = render(
        <SearchStatusActions {...savedSearch} status="PAUSED" initialCheckStatus="STOPPED" />
      );
      expect(screen.getByRole("button", { name: "Resume notifications" })).toBeTruthy();
      expect(screen.getByText("Automatic checks are paused")).toBeTruthy();

      rerender(
        <SearchStatusActions {...savedSearch} status={status} initialCheckStatus="STOPPED" />
      );

      expect(screen.queryByRole("button", { name: "Resume notifications" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Pause notifications" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
      expect(screen.queryByText("Automatic checks are paused")).toBeNull();
      expect(screen.getByText("Automatic checks have stopped")).toBeTruthy();
      expect(screen.getByText(new RegExp(`This alert is ${status.toLowerCase()}`))).toBeTruthy();
      expect(screen.queryByText(/next check:/i)).toBeNull();
    }
  );

  it("finishes optimistic checking when a fast check returns to WAITING with a newer check clock", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<SearchStatusActions {...savedSearch} />);

    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Checking" })).toBeTruthy());

    rerender(
      <SearchStatusActions
        {...savedSearch}
        initialLastCheckedAt="2026-08-14T12:01:00.000Z"
        initialNextCheckAt="2026-08-14T12:16:00.000Z"
      />
    );

    expect(screen.queryByRole("button", { name: "Checking" })).toBeNull();
    expect((screen.getByRole("button", { name: "Check now" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/last checked fri, aug 14, 8:01 am edt/i)).toBeTruthy();
    expect(screen.getByText(/next check: fri, aug 14, 8:16 am edt/i)).toBeTruthy();
    vi.useFakeTimers();
    refreshMock.mockClear();
    act(() => vi.advanceTimersByTime(5100));
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("stops refreshing when the latest saved lifecycle ends an in-progress check", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <SearchStatusActions {...savedSearch} initialCheckStatus="CHECKING" />
    );
    act(() => vi.advanceTimersByTime(2500));
    expect(refreshMock).toHaveBeenCalledTimes(1);

    rerender(
      <SearchStatusActions {...savedSearch} status="COMPLETED" initialCheckStatus="STOPPED" />
    );
    act(() => vi.advanceTimersByTime(5100));

    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Automatic checks have stopped")).toBeTruthy();
  });

  it("uses a new saved schedule even when its settings and check clocks are unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { rerender } = render(<SearchStatusActions {...savedSearch} />);
    fireEvent.click(screen.getByRole("button", { name: "Check now" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Checking" })).toBeTruthy());

    rerender(<SearchStatusActions {...savedSearch} initialScheduleVersion={2} />);

    expect(screen.queryByRole("button", { name: "Checking" })).toBeNull();
    expect((screen.getByRole("button", { name: "Check now" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("preserves an unsaved edit during a natural check refresh and reopens the latest saved settings", () => {
    const { rerender } = render(<SearchStatusActions {...savedSearch} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-08-16" } });
    fireEvent.change(screen.getByLabelText("Players"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText(/^Extra emails/), {
      target: { value: "draft@example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Move Tashua Knolls Golf Course up" }));

    rerender(
      <SearchStatusActions
        {...savedSearch}
        initialLastCheckedAt="2026-08-14T12:15:00.000Z"
        initialNextCheckAt="2026-08-14T12:30:00.000Z"
      />
    );

    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("2026-08-16");
    expect((screen.getByLabelText("Players") as HTMLSelectElement).value).toBe("4");
    expect((screen.getByLabelText(/^Extra emails/) as HTMLTextAreaElement).value).toBe("draft@example.com");
    expect(screen.getAllByRole("listitem")[0].getAttribute("aria-label")).toContain("Tashua");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    rerender(
      <SearchStatusActions
        {...savedSearch}
        initialDate="2026-08-17"
        initialStartTime="10:00"
        initialEndTime="14:00"
        initialPlayers={3}
        initialRequestedLayoutHoles={9}
        initialCadenceMinutes={30}
        initialAdditionalEmails={["saved@example.com"]}
        initialCoursePreferences={[
          { id: "pref-b", courseName: "Tashua Knolls Golf Course", rank: 1 },
          { id: "pref-a", courseName: "Longshore Golf Course", rank: 2 }
        ]}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe("2026-08-17");
    expect((screen.getByLabelText("Start") as HTMLInputElement).value).toBe("10:00");
    expect((screen.getByLabelText("End") as HTMLInputElement).value).toBe("14:00");
    expect((screen.getByLabelText("Players") as HTMLSelectElement).value).toBe("3");
    expect((screen.getByLabelText("Course layout") as HTMLSelectElement).value).toBe("9");
    expect((screen.getByLabelText("Cadence") as HTMLSelectElement).value).toBe("30");
    expect((screen.getByLabelText(/^Extra emails/) as HTMLTextAreaElement).value).toBe("saved@example.com");
    expect(screen.getAllByRole("listitem")[0].getAttribute("aria-label")).toContain("Tashua");
  });

  it("does not revive controls when an older resume response arrives after signed completion", async () => {
    let finishResume!: (response: { ok: boolean }) => void;
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => {
      finishResume = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(
      <SearchStatusActions {...savedSearch} status="PAUSED" initialCheckStatus="STOPPED" />
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume notifications" }));
    rerender(
      <SearchStatusActions {...savedSearch} status="COMPLETED" initialCheckStatus="STOPPED" />
    );

    await act(async () => finishResume({ ok: true }));

    expect(screen.queryByRole("button", { name: "Resume notifications" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Checking" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.getByText("Automatic checks have stopped")).toBeTruthy();
  });

  it("shows an accepted pause as stopped before refreshed props arrive", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    render(<SearchStatusActions {...savedSearch} />);

    fireEvent.click(screen.getByRole("button", { name: "Pause notifications" }));
    await waitFor(() => expect(screen.getByText("Automatic checks are paused")).toBeTruthy());

    expect(screen.getByRole("button", { name: "Resume notifications" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
    expect(screen.queryByText(/next check:/i)).toBeNull();
  });
});
