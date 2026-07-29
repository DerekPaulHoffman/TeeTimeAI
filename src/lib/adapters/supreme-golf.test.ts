import { describe, expect, it, vi } from "vitest";

import {
  fetchSupremeGolfTeeSheet,
  isSupremeGolfMetadata
} from "./supreme-golf";

const metadata = {
  provider: "SUPREME_GOLF" as const,
  bookingBaseUrl:
    "https://sgnavigator.app/portal/gillette-ridge-golf-club/book"
};

describe("Supreme Golf adapter", () => {
  it("validates only public SG Navigator booking routes", () => {
    expect(isSupremeGolfMetadata(metadata)).toBe(true);
    expect(isSupremeGolfMetadata({
      ...metadata,
      bookingBaseUrl: `${metadata.bookingBaseUrl}/66`
    })).toBe(true);
    expect(isSupremeGolfMetadata({
      ...metadata,
      bookingBaseUrl: "https://sgnavigator.app/portal/course/login"
    })).toBe(false);
  });

  it("discovers the course route and reads signed-out server-rendered slots", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        `<script>self.__next_f.push(["/portal/gillette-ridge-golf-club/book/66"])</script>`,
        { status: 200 }
      ))
      .mockResolvedValueOnce(new Response(`
        <div data-testid="portal-book-grid">
          <button data-testid="portal-book-tee-time-card-15:59">
            <span>3:59 PM</span><p>$60.00</p><span>1-4 players</span>
          </button>
          <button data-testid="portal-book-tee-time-card-16:08">
            <span>4:08 PM</span><p>$55.50</p><span>1-2 players</span>
          </button>
        </div>
      `, { status: 200 }));

    const result = await fetchSupremeGolfTeeSheet({
      courseId: "course-1",
      date: new Date("2026-07-29T00:00:00.000Z"),
      players: 3,
      metadata
    }, fetchMock);

    expect(result.targetDateStatus).toBe("OPEN");
    expect(result.slots).toEqual([expect.objectContaining({
      sourceId: "supreme-golf-66-1559",
      startsAt: "2026-07-29T15:59",
      availableSpots: 4,
      priceCents: 6000
    })]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      new URL("https://sgnavigator.app/portal/gillette-ridge-golf-club/book/66?day=2026-07-29"),
      expect.objectContaining({ redirect: "error" })
    );
  });

  it("uses one provider request when discovery already persisted the course route", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(`
      <div data-testid="portal-book-grid">
        <button data-testid="portal-book-tee-time-card-09:12">
          <span>9:12 AM</span><p>$45.00</p><span>1-4 players</span>
        </button>
      </div>
    `, { status: 200 }));

    const result = await fetchSupremeGolfTeeSheet({
      courseId: "course-1",
      date: new Date("2026-07-30T00:00:00.000Z"),
      players: 4,
      metadata: {
        ...metadata,
        bookingBaseUrl: `${metadata.bookingBaseUrl}/66`
      }
    }, fetchMock);

    expect(result.slots).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://sgnavigator.app/portal/gillette-ridge-golf-club/book/66?day=2026-07-30"),
      expect.objectContaining({ redirect: "error" })
    );
  });
});
