import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
        initialPlayers={2}
        initialCadenceMinutes={15}
        initialAdditionalEmails={[]}
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
        initialPlayers={2}
        initialCadenceMinutes={15}
        initialAdditionalEmails={[]}
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
});
