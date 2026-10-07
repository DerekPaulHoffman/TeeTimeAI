import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { trackWebsiteEvent } from "@/lib/engagement/client";

import { EngagementTracker } from "./engagement-tracker";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/lib/engagement/client", () => ({ trackWebsiteEvent: vi.fn() }));

const trackMock = vi.mocked(trackWebsiteEvent);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("EngagementTracker", () => {
  it("uses the accessible label when compact navigation hides visible text", () => {
    render(<EngagementTracker />);
    const link = document.createElement("a");
    link.dataset.analyticsEvent = "start_search_clicked";
    link.dataset.analyticsMode = "OUTDOOR";
    link.setAttribute("aria-label", "Find a tee time");
    Object.defineProperty(link, "innerText", { value: "" });
    document.body.append(link);
    fireEvent.click(link);
    link.remove();
    expect(trackMock).toHaveBeenLastCalledWith({
      name: "start_search_clicked", metadata: { label: "Find a tee time", mode: "OUTDOOR" }
    });
  });

  it("does not publish a malformed event for an unlabeled target", () => {
    render(<EngagementTracker />);
    const link = document.createElement("a");
    link.dataset.analyticsEvent = "start_search_clicked";
    Object.defineProperty(link, "innerText", { value: "" });
    document.body.append(link);
    fireEvent.click(link);
    link.remove();
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith({ name: "page_viewed", page: "/" });
  });

  it("attributes only valid start-search CTA modes and leaves other clicks unchanged", () => {
    render(<EngagementTracker />);

    function click(eventName: string, mode?: string) {
      const button = document.createElement("button");
      button.dataset.analyticsEvent = eventName;
      if (mode) button.dataset.analyticsMode = mode;
      Object.defineProperty(button, "innerText", { value: "Open search" });
      document.body.append(button);
      fireEvent.click(button);
      button.remove();
    }

    click("start_search_clicked", "SIMULATOR");
    click("start_search_clicked", "OUTDOOR");
    click("start_search_clicked", "invalid");
    click("dashboard_opened", "SIMULATOR");
    click("email_preview_opened", "OUTDOOR");

    expect(trackMock.mock.calls.map(([event]) => event)).toEqual([
      { name: "page_viewed", page: "/" },
      { name: "start_search_clicked", metadata: { label: "Open search", mode: "SIMULATOR" } },
      { name: "start_search_clicked", metadata: { label: "Open search", mode: "OUTDOOR" } },
      { name: "start_search_clicked", metadata: { label: "Open search" } },
      { name: "dashboard_opened", metadata: { label: "Open search" } },
      { name: "email_preview_opened", metadata: { label: "Open search" } }
    ]);
  });
});
