import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OptionalClerkProvider } from "./optional-clerk-provider";

const clerkProviderMock = vi.hoisted(() => vi.fn());

vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({
    children,
    publishableKey,
    telemetry
  }: {
    children: React.ReactNode;
    publishableKey?: string;
    telemetry?: false;
  }) => {
    clerkProviderMock({ publishableKey, telemetry });
    return <div data-testid="clerk-provider">{children}</div>;
  }
}));

describe("OptionalClerkProvider", () => {
  it("renders without Clerk when account mode is disabled", () => {
    render(
      <OptionalClerkProvider>
        <span>Search content</span>
      </OptionalClerkProvider>
    );

    expect(screen.getByText("Search content")).toBeTruthy();
    expect(screen.queryByTestId("clerk-provider")).toBeNull();
    expect(clerkProviderMock).not.toHaveBeenCalled();
  });

  it("disables optional Clerk telemetry while preserving the auth provider", () => {
    render(
      <OptionalClerkProvider publishableKey="pk_test_example">
        <span>Search content</span>
      </OptionalClerkProvider>
    );

    expect(screen.getByTestId("clerk-provider")).toBeTruthy();
    expect(clerkProviderMock).toHaveBeenCalledWith({
      publishableKey: "pk_test_example",
      telemetry: false
    });
  });
});
