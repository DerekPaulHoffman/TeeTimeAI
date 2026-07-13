import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectWebsiteTrafficClass,
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

function setWebdriver(value: boolean) {
  Object.defineProperty(navigator, "webdriver", {
    configurable: true,
    value
  });
}
