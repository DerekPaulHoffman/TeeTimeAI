import { describe, expect, it } from "vitest";

import { planSyntheticDeliveryStateRepair } from "./synthetic-delivery-state-repair";

describe("planSyntheticDeliveryStateRepair", () => {
  it("restores accepted owner deliveries and clears false suppression timestamps", () => {
    const acceptedAt = new Date("2026-07-17T04:20:31.000Z");
    const plan = planSyntheticDeliveryStateRepair(
      [
        {
          id: "search-24",
          user: { email: "golfer+tts-stress-20260714-24@example.com" },
          matches: [
            {
              id: "accepted-match",
              alertStatus: "SUPPRESSED",
              sentAt: new Date("2026-07-22T00:00:00.000Z")
            },
            {
              id: "unsent-match",
              alertStatus: "SUPPRESSED",
              sentAt: new Date("2026-07-17T04:21:00.000Z")
            },
            {
              id: "legacy-ref-match",
              alertStatus: "SUPPRESSED",
              sentAt: null
            },
            { id: "pending-match", alertStatus: "PENDING", sentAt: null }
          ],
          emailDeliveries: [
            {
              sentAt: acceptedAt,
              payload: {
                matchIds: ["accepted-match"],
                matchRefs: [
                  { matchId: "accepted-match", availabilityCycle: 1 },
                  { matchId: "legacy-ref-match", availabilityCycle: 1 }
                ]
              }
            }
          ]
        }
      ],
      "+tts-stress-20260714-"
    );

    expect(plan).toEqual([
      {
        searchId: "search-24",
        ordinal: "24",
        restoreSent: [
          { matchId: "accepted-match", sentAt: acceptedAt },
          { matchId: "legacy-ref-match", sentAt: acceptedAt }
        ],
        clearFalseSentAt: ["unsent-match"]
      }
    ]);
  });
});
