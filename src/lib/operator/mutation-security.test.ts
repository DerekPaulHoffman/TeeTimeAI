import { describe, expect, it } from "vitest";

import { assertSameOriginOperatorMutation } from "./mutation-security";

function headers(values: Record<string, string>) {
  return {
    get(name: string) {
      return values[name.toLowerCase()] ?? null;
    }
  };
}

describe("operator mutation origin validation", () => {
  it("accepts an exact forwarded HTTPS origin", () => {
    expect(() =>
      assertSameOriginOperatorMutation(
        headers({
          origin: "https://teetimespot.com",
          "x-forwarded-host": "teetimespot.com",
          "x-forwarded-proto": "https"
        })
      )
    ).not.toThrow();
  });

  it("fails closed when origin evidence is absent or cross-origin", () => {
    expect(() => assertSameOriginOperatorMutation(headers({ host: "teetimespot.com" }))).toThrow(
      "could not be verified"
    );
    expect(() =>
      assertSameOriginOperatorMutation(
        headers({
          origin: "https://attacker.example",
          host: "teetimespot.com"
        })
      )
    ).toThrow("does not match");
  });

  it("rejects malformed origins and protocol mismatches", () => {
    expect(() =>
      assertSameOriginOperatorMutation(headers({ origin: "not a url", host: "teetimespot.com" }))
    ).toThrow("malformed");
    expect(() =>
      assertSameOriginOperatorMutation(
        headers({
          origin: "http://teetimespot.com",
          host: "teetimespot.com",
          "x-forwarded-proto": "https"
        })
      )
    ).toThrow("protocol");
  });
});
