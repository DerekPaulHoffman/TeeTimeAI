import { describe, expect, it } from "vitest";
import { requestFamilyForUrl } from "./request-family";

describe("learned requests use the established provider mutex", () => {
  it("shares ForeUP's existing family lease across its public page and API", () => {
    expect(requestFamilyForUrl("https://foreupsoftware.com/index.php/booking/21017")).toBe("FOREUP");
    expect(requestFamilyForUrl("https://foreupsoftware.com/index.php/api/booking/times")).toBe("FOREUP");
  });

  it("keeps unknown hosts bounded by their actual hostname", () => {
    expect(requestFamilyForUrl("https://public.example.org/times")).toBe("public.example.org");
  });
});
