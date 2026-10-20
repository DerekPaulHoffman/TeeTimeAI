import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { continueGenericRecipeMatchSources, preserveUnambiguousMatchSources } from "./match-source-continuity";

const opening = { sourceId: "generic-hash", startsAt: new Date("2026-10-22T13:00:00Z"), endsAt: new Date("2026-10-22T14:00:00Z"),
  resourceId: "bay-1", productId: "hour-rental" };

describe("recipe repair match identity", () => {
  it("preserves one prior source identity without changing the latest observed fields", () => {
    const [matched] = preserveUnambiguousMatchSources([{ ...opening, availableSpots: 4 }], [{ ...opening, sourceId: "legacy-provider-id" }]);
    expect(matched).toEqual({ ...opening, sourceId: "legacy-provider-id", availableSpots: 4 });
  });
  it("does not merge different resources, products, durations or holes", () => {
    for (const changed of [{ resourceId: "bay-2" }, { productId: "lesson" }, { endsAt: new Date("2026-10-22T15:00:00Z") }, { holes: 18 }]) {
      expect(preserveUnambiguousMatchSources([opening], [{ ...opening, ...changed, sourceId: "other" }])[0].sourceId).toBe("generic-hash");
    }
  });
  it("keeps ambiguous prior and incoming identities separate", () => {
    expect(preserveUnambiguousMatchSources([opening], [{ ...opening, sourceId: "prior-1" }, { ...opening, sourceId: "prior-2" }])[0].sourceId).toBe("generic-hash");
    expect(preserveUnambiguousMatchSources([opening, { ...opening, sourceId: "second" }], [{ ...opening, sourceId: "prior" }])
      .map(row => row.sourceId)).toEqual(["generic-hash", "second"]);
    const secondBay = { ...opening, resourceId: "bay-2", sourceId: "generic-2" };
    expect(preserveUnambiguousMatchSources([opening, secondBay], [{ ...opening, sourceId: "legacy-1" }, { ...secondBay, sourceId: "legacy-2" }])
      .map(row => row.sourceId)).toEqual(["legacy-1", "legacy-2"]);
  });
  it("preserves exact identity in both directions for native and all recipe engines", async () => {
    const findMany = vi.fn().mockResolvedValue([{ ...opening, sourceId: "old" }]);
    const tx = { teeTimeMatch: { findMany } } as unknown as Prisma.TransactionClient;
    const scope = { searchId: "search-1", courseId: "course-1", offeringId: "offering-1" };
    expect((await continueGenericRecipeMatchSources(tx, scope, [opening]))[0].sourceId).toBe("old");
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      teeSearchId: "search-1", courseId: "course-1", offeringId: "offering-1", startsAt: { in: [opening.startsAt] },
    } }));
  });
  it("does not pick an identity from excessive history", async () => {
    const tx = { teeTimeMatch: { findMany: vi.fn().mockResolvedValue(Array.from({ length: 1001 }, () => opening)) } } as unknown as Prisma.TransactionClient;
    expect(await continueGenericRecipeMatchSources(tx, { searchId: "search", courseId: "course" }, [opening])).toEqual([opening]);
  });
});
