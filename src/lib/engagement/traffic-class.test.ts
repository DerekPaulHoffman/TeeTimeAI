import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectWebsiteTrafficClass,
  isEngineeringRemediationSearch,
  isSyntheticWebsiteTrafficClass,
  parseSyntheticMultiCycle,
  parseWebsiteTrafficClass,
  WEBSITE_TRAFFIC_CLASS_STORAGE_KEY
} from "./traffic-class";

describe("detectWebsiteTrafficClass", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    Reflect.deleteProperty(navigator, "webdriver");
    vi.restoreAllMocks();
  });

  it("marks ordinary browser activity as public", () => {
    setWebdriver(false);
    expect(detectWebsiteTrafficClass()).toBe("PUBLIC");
  });

  it("marks webdriver activity as automation without assigning an identifier", () => {
    setWebdriver(true);
    expect(detectWebsiteTrafficClass()).toBe("AUTOMATION");
  });

  it("allows an explicit per-tab test marker to override webdriver", () => {
    setWebdriver(true);
    window.sessionStorage.setItem(WEBSITE_TRAFFIC_CLASS_STORAGE_KEY, "TEST");
    expect(detectWebsiteTrafficClass()).toBe("TEST");
  });
});

describe("traffic-class persistence", () => {
  it("accepts only the bounded aggregate labels", () => {
    expect(parseWebsiteTrafficClass("TEST")).toBe("TEST");
    expect(parseWebsiteTrafficClass("AUTOMATION")).toBe("AUTOMATION");
    expect(parseWebsiteTrafficClass("customer-123")).toBe("UNCLASSIFIED");
    expect(parseWebsiteTrafficClass(null)).toBe("UNCLASSIFIED");
  });

  it("separates synthetic demand without treating unclassified demand as synthetic", () => {
    expect(isSyntheticWebsiteTrafficClass("AUTOMATION")).toBe(true);
    expect(isSyntheticWebsiteTrafficClass("TEST")).toBe(true);
    expect(isSyntheticWebsiteTrafficClass("PUBLIC")).toBe(false);
    expect(isSyntheticWebsiteTrafficClass("UNCLASSIFIED")).toBe(false);
  });

  it("requires an explicit bounded opt-in for recurring synthetic checks", () => {
    expect(parseSyntheticMultiCycle("true", "TEST")).toBe(true);
    expect(parseSyntheticMultiCycle("true", "AUTOMATION")).toBe(true);
    expect(parseSyntheticMultiCycle("false", "TEST")).toBe(false);
    expect(parseSyntheticMultiCycle("true", "PUBLIC")).toBe(false);
    expect(parseSyntheticMultiCycle("true", "UNCLASSIFIED")).toBe(false);
  });

  it("keeps real demand and explicit multi-cycle coverage in engineering remediation", () => {
    expect(isEngineeringRemediationSearch("PUBLIC", false)).toBe(true);
    expect(isEngineeringRemediationSearch("UNCLASSIFIED", false)).toBe(true);
    expect(isEngineeringRemediationSearch("TEST", true)).toBe(true);
    expect(isEngineeringRemediationSearch("AUTOMATION", true)).toBe(true);
    expect(isEngineeringRemediationSearch("TEST", false)).toBe(false);
    expect(isEngineeringRemediationSearch("AUTOMATION", false)).toBe(false);
  });
});

function setWebdriver(value: boolean) {
  Object.defineProperty(navigator, "webdriver", {
    configurable: true,
    value
  });
}
