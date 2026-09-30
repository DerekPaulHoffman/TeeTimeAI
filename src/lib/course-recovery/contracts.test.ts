import { describe, expect, it } from "vitest";
import { recoveryInputSchema } from "./contracts";
describe("bounded recovery identity hints", () => {
  it("accepts a public website and street-address hint without treating them as proof", () => {
    expect(recoveryInputSchema.parse({ name: "Harbor Dunes", town: "Harborville CT", address: "37 Fairway Drive", officialWebsite: "https://harbor.example/golf" }).address).toBe("37 Fairway Drive");
  });
  it.each(["https://user:password@harbor.example", "https://harbor.example/?token=secret", "https://harbor.example/?sessionId=abc", "https://harbor.example/?apiKey=secret", "https://harbor.example/?code=123456", "https://harbor.example/#access_token=secret", "ftp://harbor.example"]) ("rejects credential-bearing hints %s", value => {
    expect(recoveryInputSchema.safeParse({ name: "Harbor Dunes", town: "Harborville CT", officialWebsite: value }).success).toBe(false);
  });
});
