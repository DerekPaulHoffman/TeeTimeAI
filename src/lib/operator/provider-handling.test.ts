import { describe, expect, it } from "vitest";

import { getProviderHandling } from "./provider-handling";

describe("getProviderHandling", () => {
  it("explains how an automatic provider adapter supplies availability", () => {
    expect(
      getProviderHandling({
        providerFamilyKey: "FOREUP",
        monitoringMode: "AUTOMATIC",
        automationEligibility: "ALLOWED",
        bookingMethod: "PUBLIC_ONLINE"
      })
    ).toEqual({
      title: "Server adapter is the tee-time data path",
      description: expect.stringContaining(
        "read public signed-out availability"
      )
    });
  });

  it("explains the complete local-reader data path", () => {
    expect(
      getProviderHandling({
        providerFamilyKey: "CPS",
        monitoringMode: "LOCAL_READER_ONLY",
        automationEligibility: "NEEDS_REVIEW",
        bookingMethod: "PUBLIC_ONLINE"
      })
    ).toEqual({
      title: "Local reader is the tee-time data path",
      description: expect.stringContaining(
        "opens the public booking page signed out"
      )
    });
  });

  it("states when a final contact-only course has no automatic read", () => {
    expect(
      getProviderHandling({
        providerFamilyKey: "course.example",
        monitoringMode: "CONTACT_ONLY",
        automationEligibility: "BLOCKED",
        bookingMethod: "PHONE_ONLY"
      })
    ).toEqual({
      title: "No automatic tee-time data is collected",
      description: expect.stringContaining("phone call or manual contact")
    });
  });
});
