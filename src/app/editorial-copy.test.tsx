import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import AboutPage from "./about/page";
import BookingWindowsGuide from "./guides/public-golf-booking-windows/page";
import CancellationAlertsGuide from "./guides/tee-time-cancellation-alerts/page";
import AlertsVersusAutoBookingGuide from "./guides/tee-time-alerts-vs-auto-booking/page";
import HomePage from "./page";
import HowItWorksPage from "./how-it-works/page";
import MethodologyPage from "./methodology/page";
import TermsPage from "./terms/page";

describe("public SEO copy", () => {
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
