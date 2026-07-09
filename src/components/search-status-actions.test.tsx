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
});
