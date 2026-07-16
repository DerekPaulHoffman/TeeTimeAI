import { describe, expect, it, vi } from "vitest";

import { fetchWebTracTeeSheet, isWebTracMetadata } from "./webtrac";

const bookingBaseUrl =
  "https://myffr.navyaims.com/navyeast/webtrac/web/search.html?module=GR&secondarycode=25&interfaceparameter=webtrac_se";
const metadata = {
  provider: "WEBTRAC" as const,
  bookingBaseUrl,
  courseCode: "25",
  bookingWindowDaysAhead: 7,
  bookingWindowEvidenceUrl: "https://www.navymwrjacksonville.com/programs/casa-linda"
};

describe("WebTrac adapter", () => {
  it("accepts only exact Navy WebTrac golf-search metadata", () => {
    expect(isWebTracMetadata(metadata)).toBe(true);
    expect(isWebTracMetadata({ ...metadata, courseCode: "26" })).toBe(false);
    expect(isWebTracMetadata({ ...metadata, bookingBaseUrl: "https://example.com/webtrac/web/search.html?module=GR&secondarycode=25" })).toBe(false);
    expect(isWebTracMetadata({ ...metadata, bookingBaseUrl: bookingBaseUrl.replace("module=GR", "module=AR") })).toBe(false);
  });

  it("reads public result rows without following cart links", async () => {
    const html = `
      <caption class="sr-only">Tee Time Search Results</caption>
      <tr>
        <td data-title="Item Action"><a href="/addtocart.html?GRFMIDList=1313965726">Add To Cart</a></td>
        <td data-title="Time">9:08 am</td><td data-title="Date">07/18/2026</td>
        <td data-title="Holes">18 (Front)</td><td data-title="Course">Casa Linda Oaks</td>
        <td data-title="Open Slots">4</td>
      </tr>
      <tr>
        <td data-title="Item Action"><a href="/addtocart.html?GRFMIDList=1313965727">Add To Cart</a></td>
        <td data-title="Time">9:16 am</td><td data-title="Date">07/18/2026</td>
        <td data-title="Holes">9</td><td data-title="Open Slots">1</td>
      </tr>`;
    const fetchImpl = vi.fn().mockResolvedValue(new Response(html, { status: 200 }));

    await expect(fetchWebTracTeeSheet({
      courseId: "casa-linda",
      date: new Date("2026-07-18T00:00:00.000Z"),
      players: 2,
      metadata,
      discoverBookingWindow: true
    }, fetchImpl as typeof fetch)).resolves.toMatchObject({
      targetDateStatus: "OPEN",
      slots: [{
        sourceId: "webtrac-25-1313965726",
        startsAt: "2026-07-18T09:08",
        availableSpots: 4,
        holes: 18,
        bookingUrl: bookingBaseUrl
      }],
      bookingWindowEvidence: { daysAhead: 7, source: "OFFICIAL_BOOKING_PAGE" }
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain("begindate=07%2F18%2F2026");
    expect(fetchImpl.mock.calls[0][0]).not.toContain("addtocart");
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });

  it("surfaces provider failures without entering another flow", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("busy", { status: 503 }));
    await expect(fetchWebTracTeeSheet({
      courseId: "casa-linda",
      date: new Date("2026-07-18T00:00:00.000Z"),
      players: 2,
      metadata
    }, fetchImpl as typeof fetch)).rejects.toThrow("WebTrac tee times returned 503");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
