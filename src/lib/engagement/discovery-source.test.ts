import { afterEach, describe, expect, it } from "vitest";

import {
  DISCOVERY_SOURCE_STORAGE_KEY,
  classifyDiscoverySource,
  detectDiscoverySource
} from "./discovery-source";

describe("discovery source attribution", () => {
  afterEach(() => {
    window.sessionStorage.clear();
  });

  it.each([
    ["https://chatgpt.com/c/example?private=prompt", "AI_CHATGPT"],
    ["https://www.perplexity.ai/search/example", "AI_PERPLEXITY"],
    ["https://claude.ai/new", "AI_CLAUDE"],
    ["https://copilot.microsoft.com/", "AI_COPILOT"],
    ["https://gemini.google.com/app", "AI_GEMINI"],
    ["https://www.google.com/search?q=tee+time+alerts", "SEARCH_GOOGLE"],
    ["https://www.bing.com/search?q=golf", "SEARCH_BING"],
    ["https://www.bing.com/chat?q=golf", "AI_COPILOT"],
    ["https://duckduckgo.com/?q=golf", "SEARCH_OTHER"],
    ["https://example.com/recommendations", "REFERRAL_OTHER"]
  ])("reduces %s to %s", (referrer, expected) => {
    expect(classifyDiscoverySource(referrer, "https://teetimespot.com")).toBe(expected);
  });

  it("classifies same-origin navigation without keeping the URL", () => {
    expect(
      classifyDiscoverySource(
        "https://teetimespot.com/guides?email=golfer@example.com",
        "https://teetimespot.com"
      )
    ).toBe("INTERNAL");
  });

  it("reuses an aggregate source label without creating an identifier", () => {
    window.sessionStorage.setItem(DISCOVERY_SOURCE_STORAGE_KEY, "AI_CHATGPT");

    expect(detectDiscoverySource()).toBe("AI_CHATGPT");
    expect(
      Array.from({ length: window.sessionStorage.length }, (_, index) =>
        window.sessionStorage.key(index)
      )
    ).toEqual([DISCOVERY_SOURCE_STORAGE_KEY]);
  });
});
