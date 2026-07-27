import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OperatorRecentUsers } from "./operator-recent-users";

describe("OperatorRecentUsers", () => {
  it("restores registered-account and saved-alert details", () => {
    render(
      <OperatorRecentUsers
        users={[
          {
            id: "user-1",
            email: "golfer@example.com",
            createdAt: new Date("2026-07-26T19:01:51.652Z"),
            totalAlerts: 3,
            activeAlerts: 2,
            latestAlertAt: new Date("2026-07-27T12:30:00.000Z"),
            courseNames: ["Westwoods Golf Course", "Tunxis Country Club"]
          }
        ]}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Recent users" })
    ).toBeTruthy();
    expect(screen.getByText("golfer@example.com")).toBeTruthy();
    expect(screen.getByText("Westwoods Golf Course, Tunxis Country Club")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  it("shows an explicit empty state", () => {
    render(<OperatorRecentUsers users={[]} />);

    expect(screen.getByText("No registered users yet.")).toBeTruthy();
  });
});
