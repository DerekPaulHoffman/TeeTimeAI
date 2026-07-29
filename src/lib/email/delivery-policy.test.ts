import { describe, expect, it } from "vitest";

import {
  areSearchStatusEmailsEnabled,
  isSearchEmailDeliveryEnabled
} from "./delivery-policy";

describe("email delivery policy", () => {
  it("allows match alerts and the complete initial setup report", () => {
    expect(isSearchEmailDeliveryEnabled("MATCH")).toBe(true);
    expect(isSearchEmailDeliveryEnabled("SETUP")).toBe(true);
    expect(isSearchEmailDeliveryEnabled("DAILY")).toBe(false);
    expect(isSearchEmailDeliveryEnabled("MONITORING_OUTAGE")).toBe(false);
    expect(isSearchEmailDeliveryEnabled("MONITORING_RECOVERY")).toBe(false);
    expect(areSearchStatusEmailsEnabled()).toBe(true);
  });
});
