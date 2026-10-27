import { describe, expect, it } from "vitest";
import { exactFreshInspectionFrame, fixedInspectionFrameWitnessSchema, tagFreshInspectionFrame } from "./fixed-inspection-frame-witness";

const witness = { kind: "FIXED_INSPECTION_SOURCE_FRAME" as const, officialUrl: "https://course.example/",
  parentUrl: "https://course.example/golf", frameUrl: "https://public.example/html/widget",
  sourceReportSha256: "a".repeat(64) };
const frame = { src: witness.frameUrl, visible: true, srcdoc: false, inForm: false, handler: false };

describe("private fixed inspection frame witness", () => {
  it("admits only one fresh safe exact child of its parent", () => {
    expect(fixedInspectionFrameWitnessSchema.parse(witness)).toEqual(witness);
    expect(exactFreshInspectionFrame([frame], witness, witness.parentUrl)).toBe(true);
    for (const change of [{ visible: false }, { srcdoc: true }, { inForm: true }, { handler: true },
      { src: "https://public.example/html/widget?changed=1" }])
      expect(exactFreshInspectionFrame([{ ...frame, ...change }], witness, witness.parentUrl)).toBe(false);
    expect(exactFreshInspectionFrame([frame, frame], witness, witness.parentUrl)).toBe(false);
    expect(exactFreshInspectionFrame([frame], witness, witness.officialUrl)).toBe(false);
    expect(exactFreshInspectionFrame(Array(21).fill(frame), witness, witness.parentUrl)).toBe(false);
  });

  it("rejects credential, checkout and malformed private constraints", () => {
    for (const changed of [{ frameUrl: "https://user:pass@public.example/html/widget" },
      { frameUrl: "https://public.example/checkout" }, { frameUrl: witness.parentUrl },
      { sourceReportSha256: "bad" }, { unexpected: true }])
      expect(fixedInspectionFrameWitnessSchema.safeParse({ ...witness, ...changed }).success).toBe(false);
  });

  it("upgrades an already observed frame row only after its caller's fresh proof", () => {
    for (const source of [undefined, "OFFICIAL_IFRAME_SRC" as const]) {
      const rows = [{ url: witness.frameUrl, source }];
      expect(tagFreshInspectionFrame(rows, witness.frameUrl)).toBe(true);
      expect(rows).toEqual([{ url: witness.frameUrl, source: "FIXED_INSPECTION_FRAME_SRC" }]);
    }
    const rows: Array<{ url: string; source?: "FIXED_INSPECTION_FRAME_SRC" }> = [];
    expect(tagFreshInspectionFrame(rows, witness.frameUrl)).toBe(true);
    expect(rows).toEqual([{ url: witness.frameUrl, source: "FIXED_INSPECTION_FRAME_SRC" }]);
    expect(tagFreshInspectionFrame(Array(10).fill({ url: "https://other.example/" }), witness.frameUrl)).toBe(false);
  });
});
