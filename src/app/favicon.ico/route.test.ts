import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("favicon compatibility route", () => {
  it("redirects the conventional favicon path to the published app icon", async () => {
    const response = GET();

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/icon.svg");
    expect(await response.text()).toBe("Redirecting to /icon.svg");
  });
});
