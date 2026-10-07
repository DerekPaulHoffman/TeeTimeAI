import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import GolfSimulatorsPage, { metadata } from "./page";
import BookingIndoorGolfGuide, { metadata as guideMetadata } from "../guides/booking-indoor-golf/page";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("indoor golf public pages", () => {
  it("publishes distinct canonical and article metadata", () => {
    expect(metadata.title).toBe("Find Indoor Golf Simulators Near You");
    expect(metadata.alternates?.canonical).toBe("/golf-simulators");
    expect(metadata.openGraph?.type).toBe("website");
    expect(guideMetadata.title).toBe("How to Book Indoor Golf Simulator Bays");
    expect(guideMetadata.alternates?.canonical).toBe("/guides/booking-indoor-golf");
    expect(guideMetadata.openGraph?.type).toBe("article");
  });

  it("links to simulator discovery with the selected mode when enabled", () => {
    vi.stubEnv("SIMULATOR_MODE_ENABLED", "true");

    const landing = renderToStaticMarkup(<GolfSimulatorsPage />);
    const guide = renderToStaticMarkup(<BookingIndoorGolfGuide />);

    for (const html of [landing, guide]) {
      expect(html).toContain('href="/search?mode=SIMULATOR"');
      expect(html).toContain('data-analytics-event="start_search_clicked"');
      expect(html).toContain('data-analytics-mode="SIMULATOR"');
      expect(html).toMatch(/official booking link|official link/i);
      expect(html).toMatch(/one-hour|60-minute/i);
      expect(html).not.toMatch(/guaranteed availability|we book for you/i);
    }

    expect(landing).toMatch(/Discovery reaches farther than alert coverage/);
    expect(landing).toMatch(/Does selecting four players confirm the bay fits four/);
    expect(landing).not.toMatch(/after its offering is verified/);
    expect(guide).toMatch(/player choice as context/);
  });

  it("keeps both pages informative and removes simulator conversion when disabled", () => {
    vi.stubEnv("SIMULATOR_MODE_ENABLED", "false");

    const landing = renderToStaticMarkup(<GolfSimulatorsPage />);
    const guide = renderToStaticMarkup(<BookingIndoorGolfGuide />);

    for (const html of [landing, guide]) {
      expect(html).toMatch(/temporarily unavailable/i);
      expect(html).not.toContain('href="/search?mode=SIMULATOR"');
      expect(html).not.toContain('data-analytics-mode="SIMULATOR"');
      expect(html).not.toMatch(/"@type":"FAQPage"/);
    }

    expect(landing).toContain('href="/guides/booking-indoor-golf"');
    expect(guide).toMatch(/cancellation/i);
  });
});
