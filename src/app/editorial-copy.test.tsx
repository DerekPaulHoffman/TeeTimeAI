import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import AboutPage from "./about/page";
import BookingWindowsGuide from "./guides/public-golf-booking-windows/page";
import CancellationAlertsGuide from "./guides/tee-time-cancellation-alerts/page";
import AlertsVersusAutoBookingGuide from "./guides/tee-time-alerts-vs-auto-booking/page";
import HomePage from "./page";
import HowItWorksPage from "./how-it-works/page";
import MethodologyPage from "./methodology/page";
import TermsPage from "./terms/page";

describe("public SEO copy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("promotes simulators only when their search mode is enabled", () => {
    vi.stubEnv("SIMULATOR_MODE_ENABLED", "true");
    const enabledHtml = renderToStaticMarkup(<HomePage />);
    expect(enabledHtml).toContain("Now supporting golf simulators");
    expect(enabledHtml).toContain('href="/search?mode=SIMULATOR"');
    expect(enabledHtml).toContain("matching one-hour sessions at supported venues");
    expect(enabledHtml).toContain('data-analytics-mode="SIMULATOR"');

    vi.stubEnv("SIMULATOR_MODE_ENABLED", "false");
    const disabledHtml = renderToStaticMarkup(<HomePage />);
    expect(disabledHtml).not.toContain("Now supporting golf simulators");
    expect(disabledHtml).not.toContain('href="/search?mode=SIMULATOR"');
    expect(disabledHtml).not.toContain("Receive email alerts for one-hour simulator sessions");
    expect(disabledHtml).toContain('href="/search"');
    expect(disabledHtml).toContain('href="/dashboard"');
  });

  it("keeps the homepage direct and links to Connecticut alert coverage", () => {
    const html = renderToStaticMarkup(<HomePage />);

    expect(html).toContain("Free public golf tee time alerts");
    expect(html).toContain("Golf tee time alerts for the courses you want to play.");
    expect(html).toContain("last-minute tee times");
    expect(html).toContain('href="/locations/connecticut"');
    expect(html).not.toMatch(/supported availability|policy-safe|around the clock/i);
  });

  it("explains technical access limits without treating policy text as a monitoring gate", () => {
    const html = [
      renderToStaticMarkup(<HowItWorksPage />),
      renderToStaticMarkup(<MethodologyPage />),
      renderToStaticMarkup(<AboutPage />),
      renderToStaticMarkup(<TermsPage />),
      renderToStaticMarkup(<BookingWindowsGuide />),
      renderToStaticMarkup(<CancellationAlertsGuide />),
      renderToStaticMarkup(<AlertsVersusAutoBookingGuide />)
    ].join(" ");

    expect(html).toMatch(/public booking pages/i);
    expect(html).toMatch(/access control/i);
    expect(html).not.toMatch(
      /prohibits automation|policy prohibits retrieval|signed-out read-only|verified adapter|policy-safe|supported availability/i
    );
  });
});
