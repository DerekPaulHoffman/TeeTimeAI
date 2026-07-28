import { describe, expect, it } from "vitest";

import {
  areSearchStatusEmailsEnabled,
  isSearchEmailDeliveryEnabled
} from "./delivery-policy";

describe("email delivery policy", () => {
  it("allows only real tee-time match alerts", () => {
    expect(isSearchEmailDeliveryEnabled("MATCH")).toBe(true);
    expect(isSearchEmailDeliveryEnabled("SETUP")).toBe(false);
    expect(isSearchEmailDeliveryEnabled("DAILY")).toBe(false);
    expect(isSearchEmailDeliveryEnabled("MONITORING_OUTAGE")).toBe(false);
    expect(isSearchEmailDeliveryEnabled("MONITORING_RECOVERY")).toBe(false);
    expect(areSearchStatusEmailsEnabled()).toBe(false);
  });
});
