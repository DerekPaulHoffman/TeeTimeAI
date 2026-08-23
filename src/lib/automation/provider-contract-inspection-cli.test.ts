import { describe, expect, it } from "vitest";

import { parseCourseSupportProviderContractInspectionOptions } from "../../../scripts/automation/course-support";

describe("course-support provider-contract CLI", () => {
  it("accepts a shell-portable owner-bound ordinal invocation", () => {
    expect(
      parseCourseSupportProviderContractInspectionOptions([
        "--batch-ref",
        "batch-reference",
        "--ordinal",
        "01",
      ]),
    ).toEqual({ batchRef: "batch-reference", ordinal: 1 });
  });

  it.each([
    ["missing batch reference", ["--ordinal", "01"]],
    ["missing ordinal", ["--batch-ref", "batch-reference"]],
    ["zero ordinal", ["--batch-ref", "batch-reference", "--ordinal", "00"]],
    ["large ordinal", ["--batch-ref", "batch-reference", "--ordinal", "21"]],
    [
      "duplicate ordinal",
      ["--batch-ref", "batch-reference", "--ordinal", "01", "--ordinal", "02"],
    ],
    [
      "duplicate batch reference",
      [
        "--batch-ref",
        "batch-reference",
        "--batch-ref",
        "second-reference",
        "--ordinal",
        "01",
      ],
    ],
    [
      "caller URL",
      [
        "--batch-ref",
        "batch-reference",
        "--ordinal",
        "01",
        "--url",
        "https://private-canary.example/app.js",
      ],
    ],
    [
      "caller course selector",
      [
        "--batch-ref",
        "batch-reference",
        "--ordinal",
        "01",
        "--course-id",
        "private-course-canary",
      ],
    ],
    [
      "caller header",
      [
        "--batch-ref",
        "batch-reference",
        "--ordinal",
        "01",
        "--header",
        "Authorization: secret",
      ],
    ],
    [
      "caller body",
      ["--batch-ref", "batch-reference", "--ordinal", "01", "--body", "{}"],
    ],
    [
      "caller query override",
      [
        "--batch-ref",
        "batch-reference",
        "--ordinal",
        "01",
        "--query",
        "date=private-canary",
      ],
    ],
    [
      "caller cookie",
      [
        "--batch-ref",
        "batch-reference",
        "--ordinal",
        "01",
        "--cookie",
        "session=secret",
      ],
    ],
    [
      "caller asset path",
      [
        "--batch-ref",
        "batch-reference",
        "--ordinal",
        "01",
        "--asset-path",
        "/private/app.js",
      ],
    ],
  ])("rejects %s", (_label, args) => {
    expect(() =>
      parseCourseSupportProviderContractInspectionOptions(args),
    ).toThrow();
  });
});
