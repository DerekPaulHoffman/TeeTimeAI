import { describe, expect, it, vi } from "vitest";
import { isRecipeSlotWithinWindow } from "./runtime";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("./service", () => ({ assertActiveAccessRecipeInTransaction: vi.fn(), getActiveAccessRecipe: vi.fn() }));

const input = { date: "2026-10-22", timeZone: "America/New_York", players: 4, durationMinutes: 60,
  startTime: "22:00", endTime: "24:00" };
const now = new Date("2026-10-20T12:00:00Z");
describe("server acceptance of recipe window boundaries", () => {
  it("accepts a full session ending at the next venue-local midnight", () => {
    expect(isRecipeSlotWithinWindow({ startsAt: "2026-10-23T03:00:00Z", endsAt: "2026-10-23T04:00:00Z" }, input, now)).toBe(true);
  });
  it("rejects a start inside the window whose end is after midnight", () => {
    expect(isRecipeSlotWithinWindow({ startsAt: "2026-10-23T03:30:00Z", endsAt: "2026-10-23T04:30:00Z" }, input, now)).toBe(false);
    expect(isRecipeSlotWithinWindow({ startsAt: "2026-10-23T02:00:00Z", endsAt: "2026-10-23T10:00:00Z" }, input, now)).toBe(false);
  });
  it("rejects an ordinary same-day end-window overrun and exact end-window start", () => {
    expect(isRecipeSlotWithinWindow({ startsAt: "2026-10-23T02:30:00Z", endsAt: "2026-10-23T03:30:00Z" }, { ...input, endTime: "23:00" }, now)).toBe(false);
    expect(isRecipeSlotWithinWindow({ startsAt: "2026-10-23T03:00:00Z" }, { ...input, endTime: "23:00" }, now)).toBe(false);
  });
  it("uses the midnight offset after a DST transition", () => {
    expect(isRecipeSlotWithinWindow({ startsAt: "2026-11-02T04:00:00Z", endsAt: "2026-11-02T05:00:00Z" }, { ...input, date: "2026-11-01" }, now)).toBe(true);
    expect(isRecipeSlotWithinWindow({ startsAt: "2026-11-02T04:30:00Z", endsAt: "2026-11-02T05:30:00Z" }, { ...input, date: "2026-11-01" }, now)).toBe(false);
  });
});
