import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn()
  })
}));
vi.mock("./actions", () => ({
  setCourseOutcomeAction: vi.fn(),
  updateOfficialLinksAction: vi.fn()
}));

import { CourseOutcomeForm, OfficialLinksForm } from "./operator-course-controls";

const identity = {
  reference: "cm_123456789012345678901234",
  statusRevision: 4,
  incidentCycle: 2,
  incidentRevision: 7,
  idempotencyKey: "operator-controls-123456"
};

describe("operator course controls", () => {
  it("makes both official URLs editable and ties changes to verification", () => {
    render(
      <OfficialLinksForm
        {...identity}
        bookingUrl="https://course.example/book"
        monitoringPath="Automatic"
        platform="Unknown"
        provider="SOURCE_MISSING"
        providerHandling={{
          title: "AI is identifying the provider",
          description: "The AI checks the official links."
        }}
        providerLabel="Source missing"
        providerOptions={["FOREUP", "CPS"]}
        website="https://course.example"
      />
    );

    const save = screen.getByRole("button", { name: "Save provider and links" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText("Tee-time provider")).toBeTruthy();
    expect(screen.getByLabelText("Official course site")).toBeTruthy();
    expect(screen.getByLabelText("Official booking page")).toBeTruthy();
    expect(screen.queryByLabelText("Official evidence")).toBeNull();

    fireEvent.change(screen.getByLabelText("Official booking page"), {
      target: { value: "https://course.example/new-booking" }
    });

    expect((save as HTMLButtonElement).disabled).toBe(false);
    expect(
      screen.getByText(/Verification and a fresh check start automatically/)
    ).toBeTruthy();
    expect(screen.getByText("AI is identifying the provider")).toBeTruthy();
  });

  it("keeps the provider editable and enables verification when it changes", () => {
    render(
      <OfficialLinksForm
        {...identity}
        bookingUrl="https://course.example/book"
        monitoringPath="Automatic"
        platform="Unknown"
        provider="SOURCE_MISSING"
        providerHandling={{
          title: "AI is identifying the provider",
          description: "The AI checks the official links."
        }}
        providerLabel="Source missing"
        providerOptions={["FOREUP", "CPS"]}
        website="https://course.example"
      />
    );

    const save = screen.getByRole("button", { name: "Save provider and links" });
    fireEvent.change(screen.getByLabelText("Tee-time provider"), {
      target: { value: "FOREUP" }
    });

    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers temporary, private, local-reader, and manual outcomes without evidence fields", () => {
    render(<CourseOutcomeForm {...identity} />);

    const outcome = screen.getByLabelText("Course outcome or monitoring path");
    expect(screen.getByRole("option", { name: "Use the local tee-time reader" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Course website temporarily unavailable" })
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "This is a private course" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Phone or manual booking only" })).toBeTruthy();
    expect(screen.queryByLabelText("Official evidence")).toBeNull();

    fireEvent.change(outcome, {
      target: { value: "PRIVATE_COURSE" }
    });

    expect(
      screen.getByText(/Close monitoring because this is a private course/)
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Set final outcome" }) as HTMLButtonElement).disabled
    ).toBe(false);

    fireEvent.change(outcome, {
      target: { value: "WEBSITE_TEMPORARILY_UNAVAILABLE" }
    });

    expect(screen.getByText(/Keep the alert active/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set temporary status" })).toBeTruthy();
  });

  it("preselects the one-click local-reader action for compatible EZLinks courses", () => {
    render(<CourseOutcomeForm {...identity} recommendLocalReader />);

    expect(
      screen.getByText(/This booking page is compatible with the local reader/)
    ).toBeTruthy();
    expect(
      (screen.getByLabelText("Course outcome or monitoring path") as HTMLSelectElement).value
    ).toBe("LOCAL_READER");
    expect(
      (screen.getByRole("button", {
        name: "Use local reader and recheck"
      }) as HTMLButtonElement).disabled
    ).toBe(false);
  });
});
