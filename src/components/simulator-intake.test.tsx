import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SimulatorIntake, simulatorSelectionProblem } from "./simulator-intake";
import type { CourseCandidate } from "@/lib/places/google";

const venue: CourseCandidate = { googlePlaceId: "verified-simulator", courseId: "venue", offeringId: "sim-offering", mode: "SIMULATOR",
  name: "Public Simulator Venue", address: "100 Simulator Road, Connecticut", latitude: 41, longitude: -73, timeZone: "America/New_York",
  publicAccessStatus: "PUBLIC", maxPartySize: 6, supportedDurationsMinutes: [60, 90, 120], website: "https://official.example/simulators" };

describe("simulator intake", () => {
  beforeEach(() => { sessionStorage.clear(); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("requires verified simulator rental, capacity and the requested duration", () => {
    expect(simulatorSelectionProblem(venue, 4, 90)).toBeNull();
    expect(simulatorSelectionProblem({ ...venue, offeringId: undefined }, 4, 90)).toContain("verification");
    expect(simulatorSelectionProblem({ ...venue, mode: "OUTDOOR" }, 4, 90)).toContain("verification");
    expect(simulatorSelectionProblem(venue, 7, 60)).toContain("6 players");
    expect(simulatorSelectionProblem(venue, 4, 180)).toContain("duration");
  });

  it("saves duration and offering identity without claiming the client's email as owner", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(url === "/api/searches" ? { search: { id: "saved-simulator" } } : { courses: [venue] }), { status: url === "/api/searches" ? 201 : 200 });
    }));
    render(<SimulatorIntake initialValues={{ date: "2080-06-02" }} accountEnabled accountSignedIn accountEmail="owner@example.com" />);
    fireEvent.change(screen.getByLabelText("Find a simulator venue by name and town"), { target: { value: "Public Simulator Venue Connecticut" } });
    fireEvent.click(screen.getByRole("button", { name: "Find venue" }));
    await screen.findByRole("button", { name: "Add to alert" });
    fireEvent.click(screen.getByRole("button", { name: "Add to alert" }));
    fireEvent.change(screen.getByLabelText("Session length"), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Create simulator alert" }));
    await waitFor(() => expect(calls.some(call => call.url === "/api/searches")).toBe(true));
    const request = JSON.parse(calls.find(call => call.url === "/api/searches")!.init!.body as string);
    expect(request).toMatchObject({ mode: "SIMULATOR", durationMinutes: 90, players: 4, requestedLayoutHoles: null,
      courses: [{ offeringId: "sim-offering", rank: 1 }] });
    expect(request).not.toHaveProperty("alertEmail");
    expect(request).not.toHaveProperty("userId");
    expect(calls.every(call => !call.url.includes("known-times") && !call.url.includes("check-times"))).toBe(true);
    await screen.findByRole("link", { name: "View my alert" });
  });

  it("blocks a session that cannot fit inside the available time window", async () => {
    render(<SimulatorIntake initialValues={{ date: "2080-06-02", startTime: "18:00", endTime: "19:00", durationMinutes: 90 }} accountEnabled accountSignedIn accountEmail="owner@example.com" />);
    await screen.findByText("Choose a window long enough for the full 90-minute session.");
    expect((screen.getByRole("button", { name: "Create simulator alert" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("group", { name: "Course layout" })).toBeNull();
  });
  it("restores ranked simulator demand after returning from sign-in without restoring a readiness claim", async () => {
    sessionStorage.setItem("tee-time-spot:simulator-draft:v1", JSON.stringify({ location: "Fairfield, CT", date: "2080-06-02", startTime: "09:00", endTime: "18:00", players: 4,
      durationMinutes: 120, radius: 15, selectedVenues: [{ ...venue, monitoringReadiness: "READY" }] }));
    render(<SimulatorIntake initialValues={{}} accountEnabled accountSignedIn accountEmail="owner@example.com" />);
    await waitFor(() => expect(screen.getByRole("complementary", { name: "Ranked simulator venues" }).textContent).toContain(venue.name));
    expect((screen.getByRole("button", { name: "Create simulator alert" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByLabelText("Session length") as HTMLSelectElement).value).toBe("120");
    expect(JSON.parse(sessionStorage.getItem("tee-time-spot:simulator-draft:v1")!).selectedVenues[0].monitoringReadiness).toBe("VERIFYING");
  });
});
