import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("favicon compatibility route", () => {
  it("serves a valid ICO containing the published app icon", async () => {
    const response = GET();
    const bytes = new Uint8Array(await response.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const imageOffset = view.getUint32(18, true);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/x-icon");
    expect([...bytes.slice(0, 6)]).toEqual([0, 0, 1, 0, 1, 0]);
    expect([...bytes.slice(imageOffset, imageOffset + 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10
    ]);
    expect(bytes.length).toBeGreaterThan(1_000);
  });
});
