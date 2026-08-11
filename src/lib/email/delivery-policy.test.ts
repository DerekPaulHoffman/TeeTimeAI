import { describe, expect, it } from "vitest";

import {
  areSearchStatusEmailsEnabled,
  isSearchEmailDeliveryEnabled
} from "./delivery-policy";

describe("email delivery policy", () => {
  it("allows match, setup, and consolidated monitoring transition emails", () => {
    expect(isSearchEmailDeliveryEnabled("MATCH")).toBe(true);
    expect(isSearchEmailDeliveryEnabled("SETUP")).toBe(true);
    expect(isSearchEmailDeliveryEnabled("DAILY")).toBe(false);
    expect(isSearchEmailDeliveryEnabled("MONITORING_STATUS_UPDATE")).toBe(true);
    expect(isSearchEmailDeliveryEnabled("MONITORING_OUTAGE")).toBe(true);
    expect(isSearchEmailDeliveryEnabled("MONITORING_RECOVERY")).toBe(true);
    expect(areSearchStatusEmailsEnabled()).toBe(true);
  });
});
