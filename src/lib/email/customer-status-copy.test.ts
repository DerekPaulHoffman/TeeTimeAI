import { describe, expect, it } from "vitest";

import { CUSTOMER_EMAIL_STATES, getCustomerStatusCopy } from "./customer-status-copy";
import { renderEmailStatePreview } from "./preview-states";

describe("customer status wording", () => {
  it("separates an incomplete check from an empty result and a final access limit", () => {
    const retry = getCustomerStatusCopy("retrying");
    expect(retry).toMatchObject({ badgeLabel: "WE’RE CHECKING ON IT", userActionNeeded: false });
    expect(`${retry.heading}. ${retry.detail} ${retry.nextStep}`).toBe(
      "Your alert is still active. We couldn’t confirm openings on our last check. We’ll check again automatically. You don’t need to do anything."
    );
    expect(retry.detail).not.toMatch(/no matching|sold out|unavailable/i);
    expect(getCustomerStatusCopy("watching").detail).toContain("found no tee times matching");
    for (const state of ["review", "direct", "phone", "account", "verification", "invalid"] as const) {
      const copy = getCustomerStatusCopy(state);
      expect(copy.userActionNeeded).toBe(true);
      expect(`${copy.detail} ${copy.nextStep}`).not.toMatch(/No action needed|check again automatically|our team is|we’re working/i);
    }
  });

  it("keeps an inventory estimate distinct from a confirmed release", () => {
    const estimate = getCustomerStatusCopy("expected", { facts: "Usually released around Wednesday, based on recent observations." });
    expect(estimate.detail).toContain("based on recent observations");
    expect(estimate.heading).toContain("may appear later");
    expect(estimate.badgeLabel).not.toContain("BOOKING TO OPEN");
    expect(getCustomerStatusCopy("window", { facts: "Booking opens Wednesday at 7 AM EDT." }).detail)
      .toBe("Booking opens Wednesday at 7 AM EDT.");
  });

  it.each([false, true])("renders every finite preview state without customer actions or mode leakage (simulator=%s)", simulator => {
    for (const state of CUSTOMER_EMAIL_STATES) {
      const html = renderEmailStatePreview(state, simulator)!;
      expect(html).toContain(`data-email-state="${state}"`);
      expect(html).toContain("sample update");
      expect(html).toContain("preview-cancelled");
      expect(html).not.toMatch(/PRIORITY|<script|fetch\(/i);
      if (simulator) expect(html).not.toMatch(/tee times|golfers|holes|green fee|course layout/i);
      if (state === "identity" || state === "invalid") expect(html).not.toContain("https://example.com/booking");
    }
    expect(renderEmailStatePreview("<script>invalid</script>", simulator)).toBeNull();
    expect(renderEmailStatePreview("mixed", simulator)).toBeNull();
  });
});
