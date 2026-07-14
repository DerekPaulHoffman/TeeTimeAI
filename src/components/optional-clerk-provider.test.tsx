import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OptionalClerkProvider } from "./optional-clerk-provider";

const clerkProviderMock = vi.hoisted(() => vi.fn());

vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({
    children,
    prefetchUI
  }: {
    children: React.ReactNode;
    prefetchUI?: boolean;
  }) => {
    clerkProviderMock({ prefetchUI });
    return <div data-testid="clerk-provider">{children}</div>;
  }
}));

describe("OptionalClerkProvider", () => {
  it("renders without Clerk when account mode is disabled", () => {
    render(
      <OptionalClerkProvider enabled={false}>
        <span>Search content</span>
      </OptionalClerkProvider>
    );

    expect(screen.getByText("Search content")).toBeTruthy();
    expect(screen.queryByTestId("clerk-provider")).toBeNull();
    expect(clerkProviderMock).not.toHaveBeenCalled();
  });

  it("defers Clerk UI downloads while preserving the auth provider", () => {
    render(
      <OptionalClerkProvider enabled>
        <span>Search content</span>
      </OptionalClerkProvider>
    );

    expect(screen.getByTestId("clerk-provider")).toBeTruthy();
    expect(clerkProviderMock).toHaveBeenCalledWith({ prefetchUI: false });
  });
});
