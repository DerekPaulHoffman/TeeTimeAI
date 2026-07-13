import { describe, expect, it } from "vitest";

import { requireTrustedVercelPreviewUrl } from "./vercel-preview-auth";

describe("requireTrustedVercelPreviewUrl", () => {
  it("accepts Tee Time Spot deployment and Git branch preview URLs", () => {
    expect(
      requireTrustedVercelPreviewUrl(
        "https://teetimeai-abc123-derekpaulhoffmans-projects.vercel.app"
      ).hostname
    ).toBe("teetimeai-abc123-derekpaulhoffmans-projects.vercel.app");
    expect(
      requireTrustedVercelPreviewUrl(
        "https://teetimeai-git-feature-checks-derekpaulhoffmans-projects.vercel.app/"
      ).hostname
    ).toBe("teetimeai-git-feature-checks-derekpaulhoffmans-projects.vercel.app");
  });

  it.each([
    "http://teetimeai-abc123-derekpaulhoffmans-projects.vercel.app",
    "https://attacker.vercel.app",
    "https://teetimeai.example.com",
    "https://teetimeai-abc123-derekpaulhoffmans-projects.vercel.app/path",
    "https://teetimeai-abc123-derekpaulhoffmans-projects.vercel.app/?next=attacker"
  ])("rejects an untrusted preview target: %s", (value) => {
    expect(() => requireTrustedVercelPreviewUrl(value)).toThrow(
      "Preview smoke requires the root HTTPS URL"
    );
  });
});
