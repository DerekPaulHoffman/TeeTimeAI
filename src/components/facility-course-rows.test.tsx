import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FacilityCourseRows } from "./facility-course-rows";
import type { CourseCandidate } from "@/lib/places/google";
import { consumeSearchPrefill } from "@/lib/searches/search-prefill";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const knolls: CourseCandidate = { courseId: "knolls", googlePlaceId: "same-place", name: "Tashua Knolls", latitude: 41.24, longitude: -73.2, timeZone: "America/New_York", layoutHoleCounts: [18], website: "https://official.example/knolls" };
const glen: CourseCandidate = { ...knolls, courseId: "glen", name: "Tashua Glen", layoutHoleCounts: [9], website: "https://official.example/glen" };
afterEach(() => { cleanup(); vi.clearAllMocks(); window.sessionStorage.clear(); });

describe("individual course actions within one facility card", () => {
  it("selects the named physical course and applies the physical-layout filter independently", () => {
    const notify = vi.fn();
    render(<FacilityCourseRows courses={[knolls, glen]} onNotify={notify} requestedLayoutHoles={9} />);
    expect(screen.getByRole("button", { name: "Notify me for Tashua Knolls" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Notify me for Tashua Glen" }));
    expect(notify).toHaveBeenCalledExactlyOnceWith(glen);
  });
  it("keeps available 9-hole round products on the 18-hole Knolls course separate from Glen's failed check", () => {
    render(<FacilityCourseRows courses={[knolls, glen]} timeFilters={{ date: "2026-10-29", startTime: "06:00", endTime: "18:00", players: 4 }}
      checks={{ knolls: { status: "CHECKED", times: [{ startsAt: "2026-10-29T12:30:00Z", availableSpots: 4, holes: 9, priceCents: 2700, bookingUrl: knolls.website!, confirmedAt: "2026-10-28T16:44:55Z" }] }, glen: { status: "FAILED", times: [] } }} />);
    const primary = screen.getByRole("region", { name: "Tashua Knolls" });
    const secondary = screen.getByRole("region", { name: "Tashua Glen" });
    expect(primary.textContent).toContain("18-hole course");
    expect(primary.textContent).toContain("9-hole round · $27.00");
    expect(secondary.textContent).toContain("couldn't check");
    expect(secondary.textContent).not.toContain("$27");
    expect(secondary.textContent).not.toContain("No matching");
    expect(within(primary).getByRole("link", { name: /^8:30 AM/ }).getAttribute("href")).toBe(knolls.website);
  });
  it("starts a new course-scoped flow from a saved card without mutating the old alert", () => {
    render(<FacilityCourseRows courses={[knolls, glen]} savedStatuses={{ knolls: { label: "Checks stopped", detail: "Completed alert" } }} />);
    expect(screen.getByRole("region", { name: "Tashua Glen" }).textContent).toContain("Not included in this alert");
    fireEvent.click(screen.getByRole("button", { name: "Notify me for Tashua Glen" }));
    expect(push).toHaveBeenCalledExactlyOnceWith("/search");
    expect(consumeSearchPrefill()?.selectedCourse?.courseId).toBe("glen");
  });
});
